import Foundation
import Observation

/// Chat state — conversation list, active conversation's messages, one live
/// SSE stream, and the send flow (POST → 202 → deltas over SSE).
///
/// Caching: the conversation list and each conversation's message tail are
/// written to DiskCache so relaunches render instantly (stale-while-revalidate).
@Observable
@MainActor
final class ChatStore {
    private let api = WalnutAPI()
    private var sse: SSEClient?
    weak var connection: ConnectionStore?

    /// Last time ANY SSE event arrived — feeds the turn-stall reconciler.
    private var lastSSEEventAt = Date()
    /// Watches an in-flight turn: if SSE goes silent, reconcile via REST so a
    /// dead stream can never leave `streaming` stuck true (frozen composer).
    private var turnWatchdog: Task<Void, Never>?
    /// Text of the user message whose turn is being watched — the reconciler
    /// only trusts an assistant reply that comes AFTER this message in server
    /// history (guards against a queued turn misreading the PREVIOUS turn's
    /// trailing assistant message as completion).
    private var watchedUserText: String?

    var conversations: [ConversationSummary] = []
    var activeID: String?
    var messages: [ChatMessage] = []
    var hasOlder = false

    /// Console agents (Walnut = main, Mentor, Note Assistant, …).
    var agents: [AgentSummary] = []
    var activeAgentID = "general"

    var activeAgent: AgentSummary? {
        agents.first(where: { $0.id == activeAgentID })
    }

    /// Nav-bar title: the agent's name ("Walnut" for the main butler).
    var activeAgentName: String {
        activeAgent?.name ?? (activeAgentID == "general" ? "Walnut" : activeAgentID)
    }

    /// Whether the view's bottom sentinel is on screen — written by the view.
    /// Read before layout-shifting mutations to decide if the list should
    /// re-pin to the bottom (never hijack a reader scrolled up in history).
    var viewIsAtBottom = true
    /// Bumped when a mutation may have displaced the viewport while the user
    /// was at the bottom; the view answers by scrolling to its sentinel.
    private(set) var scrollToBottomSignal = 0
    /// First-paint pin guard. `defaultScrollAnchor(.bottom)` alone positions
    /// the viewport at the LazyVStack's ESTIMATED bottom; with variable-height
    /// markdown rows the estimate is far off and the rows at the real offset
    /// are never instantiated — the list renders BLANK until any gesture
    /// forces a layout pass (QA-confirmed, intermittent). The first load must
    /// therefore always fire the scroll signal: scrollTo(sentinel) runs after
    /// real layout, clamps to content bounds, and forces the bottom rows in.
    private var initialPaintDone = false

    var loadingList = false
    var loadingMessages = false
    var sending = false
    /// A turn is running on the active conversation (composer disabled).
    var streaming = false
    /// Accumulated live assistant text for the in-flight turn.
    var streamText = ""
    /// Delta coalescing (freeze fix): applying every SSE text-delta straight
    /// to `streamText` re-rendered the live markdown row PER DELTA — a full
    /// MarkdownParser.parse of the ever-growing reply on the main thread,
    /// dozens of times a second. Long replies saturated the main thread and
    /// froze the app. Deltas buffer here (non-observed via ObservationIgnored)
    /// and flush on a ~8Hz cadence instead.
    @ObservationIgnored private var pendingDelta = ""
    @ObservationIgnored private var deltaFlushTask: Task<Void, Never>?
    /// Latest tool/thinking status, e.g. "Read" — shown as an activity row.
    var activity: String?
    var errorMessage: String?

    private static let pageSize = 50
    private static let cacheTail = 60

    // MARK: - Lifecycle

    /// Load cache, pick the most recent conversation, refresh from network.
    func initialize() async {
        if let savedAgent = UserDefaults.standard.string(forKey: "walnut.activeAgent") {
            activeAgentID = savedAgent
        }
        if let cachedAgents: [AgentSummary] = DiskCache.load([AgentSummary].self, key: "agents") {
            agents = cachedAgents
        }
        if let cachedList: [ConversationSummary] = DiskCache.load([ConversationSummary].self, key: conversationsCacheKey) {
            conversations = cachedList
        }
        if let saved = UserDefaults.standard.string(forKey: activeConversationKey) {
            select(saved)
        }
        await refreshAgents()
        await refreshConversations()
        if activeID == nil || !conversations.contains(where: { $0.id == activeID }) {
            select(conversations.first?.id)
        }
    }

    /// Per-agent persistence keys — each agent remembers its own thread.
    private var activeConversationKey: String { "walnut.activeConversation.\(activeAgentID)" }
    private var conversationsCacheKey: String { "conversations-\(activeAgentID)" }

    func refreshAgents() async {
        do {
            let fetched = try await api.agents()
            if !fetched.isEmpty {
                agents = fetched
                DiskCache.save(agents, key: "agents")
                // The active agent can vanish (deleted on the console) — fall home.
                if !agents.contains(where: { $0.id == activeAgentID }) {
                    switchAgent("general")
                }
            }
        } catch {
            // Older servers don't have /agents — chat still works on general.
            reportIfNetwork(error)
        }
    }

    /// Switch console agent: park the current stream, swap conversation scope.
    func switchAgent(_ agentID: String) {
        guard agentID != activeAgentID else { return }
        activeAgentID = agentID
        UserDefaults.standard.set(agentID, forKey: "walnut.activeAgent")
        activeID = nil
        conversations = DiskCache.load([ConversationSummary].self, key: conversationsCacheKey) ?? []
        messages = []
        hasOlder = false
        if let saved = UserDefaults.standard.string(forKey: activeConversationKey) {
            select(saved)
        } else {
            select(conversations.first?.id)
        }
        Task {
            await refreshConversations()
            if activeID == nil || !conversations.contains(where: { $0.id == activeID }) {
                select(conversations.first?.id)
            }
        }
    }

    func refreshConversations() async {
        loadingList = true
        defer { loadingList = false }
        do {
            let agentID = activeAgentID
            let fetched = try await api.conversations(agentID: agentID)
            connection?.reportReachability(true)
            guard agentID == activeAgentID else { return }
            conversations = fetched
            DiskCache.save(conversations, key: conversationsCacheKey)
        } catch {
            reportIfNetwork(error)
        }
    }

    /// Switch the active conversation: render cache instantly, reconnect SSE,
    /// then revalidate messages from the network.
    func select(_ id: String?) {
        guard id != activeID || sse == nil else { return }
        activeID = id
        UserDefaults.standard.set(id, forKey: activeConversationKey)
        turnWatchdog?.cancel()
        turnWatchdog = nil
        deltaFlushTask?.cancel()
        deltaFlushTask = nil
        pendingDelta = ""
        streaming = false
        streamText = ""
        activity = nil
        errorMessage = nil
        initialPaintDone = false
        messages = id.flatMap { DiskCache.load([ChatMessage].self, key: "messages-\($0)") } ?? []
        // Cached rows landed — force the bottom rows to instantiate (the
        // blank-list bug hits the cold-launch cache path hardest). Deferred a
        // tick so the view is attached and observing before the signal moves.
        if !messages.isEmpty {
            Task { @MainActor in self.scrollToBottomSignal += 1 }
        }
        connectStream()
        if let id {
            Task { await self.loadMessages(id) }
        }
    }

    func startNewConversation() {
        // Lazy: created server-side on first send.
        select(nil)
    }

    /// Nav-bar title — the agent's name; the conversation title rides subtitle-style.
    var activeTitle: String {
        guard let activeID else { return activeAgentName }
        return conversations.first(where: { $0.id == activeID })?.title ?? activeAgentName
    }

    // MARK: - Messages

    func loadMessages(_ id: String) async {
        loadingMessages = true
        defer { loadingMessages = false }
        do {
            let agentID = activeAgentID
            let fetched = try await api.messages(conversationID: id, agentID: agentID, limit: Self.pageSize)
            connection?.reportReachability(true)
            guard id == activeID, agentID == activeAgentID else { return }
            // Carry local-only bubbles (failed sends, in-flight optimistic)
            // across the replace — server history doesn't know about them and
            // a refetch must never erase the user's unsent text.
            let localOnly = messages.filter { $0.failed == true || $0.pending == true }
            let wasAtBottom = viewIsAtBottom
            let changed = fetched.count + localOnly.count != messages.count
                || fetched.last?.id != messages.dropLast(localOnly.count).last?.id
            messages = fetched + localOnly
            hasOlder = fetched.count >= Self.pageSize
            // Replacing rows with canonical ids/heights displaces the viewport
            // once the bottom anchor's auto-pin has lapsed (any manual scroll)
            // — glue the reader back only if they were already at the bottom.
            // The FIRST load always pins: see initialPaintDone (blank-list fix).
            if !initialPaintDone || (changed && wasAtBottom) { scrollToBottomSignal += 1 }
            initialPaintDone = true
            DiskCache.save(Array(fetched.suffix(Self.cacheTail)), key: "messages-\(id)")
        } catch {
            reportIfNetwork(error)
        }
    }

    func loadOlder() async {
        guard let id = activeID, hasOlder, !loadingMessages,
              let oldest = messages.first(where: { $0.pending != true })
        else { return }
        loadingMessages = true
        defer { loadingMessages = false }
        do {
            let older = try await api.messages(conversationID: id, agentID: activeAgentID, limit: Self.pageSize, before: oldest.id)
            guard id == activeID else { return }
            messages.insert(contentsOf: older, at: 0)
            hasOlder = older.count >= Self.pageSize
        } catch {
            reportIfNetwork(error)
        }
    }

    // MARK: - Send flow (POST → 202 {turnId} → SSE deltas)

    @discardableResult
    func send(_ text: String, images: [SelectedImage] = []) async -> Bool {
        guard !sending, !streaming else { return false }
        sending = true
        errorMessage = nil

        let payloads = images.map { ImagePayload(data: $0.jpegData.base64EncodedString(), mediaType: "image/jpeg") }
        var convID = activeID
        var optimistic = ChatMessage(
            id: "local-\(Date().timeIntervalSince1970)",
            role: "user", text: text, createdAt: ISO8601DateFormatter().string(from: .now), kind: nil
        )
        optimistic.pending = true
        // Carry thumbnails so the bubble shows them immediately and a failed
        // send retains them for retry (the store owns no-loss preservation).
        if !images.isEmpty { optimistic.localImages = images.map(\.jpegData) }

        // Append FIRST — even a createConversation failure must leave the
        // text + images on screen as a failed bubble, never lose them.
        messages.append(optimistic)
        // Sending always jumps to the bottom — the user wants to see their own
        // message land even if they were scrolled up reading history.
        scrollToBottomSignal += 1
        do {
            if convID == nil {
                let created = try await api.createConversation(agentID: activeAgentID)
                convID = created
                activeID = created
                UserDefaults.standard.set(created, forKey: activeConversationKey)
                connectStream()
            }
            guard let convID else {
                sending = false
                if let idx = messages.firstIndex(where: { $0.id == optimistic.id }) {
                    messages[idx].pending = false
                    messages[idx].failed = true
                }
                return false
            }
            _ = try await api.sendMessage(conversationID: convID, agentID: activeAgentID, text: text, images: payloads)
            connection?.reportReachability(true)
            // Accepted — solidify the bubble; message-start arrives on SSE shortly.
            if let idx = messages.firstIndex(where: { $0.id == optimistic.id }) {
                messages[idx].pending = false
            }
            sending = false
            streaming = true
            streamText = ""
            activity = nil
            watchedUserText = text
            startTurnWatchdog(conversationID: convID)
            return true
        } catch {
            sending = false
            if let apiError = error as? APIError, apiError.isTurnActive {
                // Another turn is running — keep the text as a failed bubble
                // (the draft is already cleared) so it can be retried after
                // message-end, and gate sends until then.
                if let idx = messages.firstIndex(where: { $0.id == optimistic.id }) {
                    messages[idx].pending = false
                    messages[idx].failed = true
                }
                streaming = true
                watchedUserText = nil
                if let convID { startTurnWatchdog(conversationID: convID) }
                errorMessage = "The assistant is already replying — tap the message to retry when it finishes."
            } else {
                // KEEP the bubble, marked failed — the user's text must never
                // vanish on a network error. Tap to retry / copy / delete.
                if let idx = messages.firstIndex(where: { $0.id == optimistic.id }) {
                    messages[idx].pending = false
                    messages[idx].failed = true
                }
                reportIfNetwork(error)
                errorMessage = error.localizedDescription
            }
            return false
        }
    }

    // MARK: - Failed-bubble actions

    /// Re-send a failed bubble: remove it and run the normal send flow with
    /// the same text (a fresh optimistic bubble appears immediately).
    /// Precondition-guarded — send()'s busy guard returns without appending,
    /// so removing the bubble first would LOSE the text mid-turn.
    func retry(_ message: ChatMessage) async {
        guard message.failed == true else { return }
        guard !sending, !streaming else {
            errorMessage = "Still replying — retry when the turn finishes."
            return
        }
        // Rebuild the attached images from the retained JPEG datas so retry
        // re-sends them (no loss); silently drop any that no longer decode.
        let images = (message.localImages ?? []).compactMap { SelectedImage(jpegData: $0) }
        messages.removeAll { $0.id == message.id }
        errorMessage = nil
        await send(message.text, images: images)
    }

    func discardFailed(_ message: ChatMessage) {
        messages.removeAll { $0.id == message.id }
    }

    // MARK: - SSE

    func connectStream() {
        sse?.stop()
        sse = nil
        guard let convID = activeID,
              let base = AppConfig.serverURL,
              let token = AppConfig.token,
              let url = URL(string: "\(base.absoluteString)/api/v1/conversations/\(convID)/stream?agentId=\(activeAgentID)")
        else { return }

        sse = SSEClient(
            url: url,
            token: token,
            onEvent: { [weak self] event in
                Task { @MainActor in
                    self?.handle(event, conversationID: convID)
                }
            },
            onConnectionChange: { [weak self] ok in
                Task { @MainActor in
                    self?.connection?.reportReachability(ok)
                }
            }
        )
        sse?.start()
    }

    func closeStream() {
        sse?.stop()
        sse = nil
        turnWatchdog?.cancel()
        turnWatchdog = nil
    }

    private struct DeltaPayload: Codable { let delta: String }
    private struct ToolPayload: Codable { let name: String }
    private struct EndPayload: Codable { let turnId: String; let fullText: String }
    private struct ErrorPayload: Codable { let message: String }

    private func handle(_ event: SSEEvent, conversationID: String) {
        guard conversationID == activeID else { return }
        lastSSEEventAt = Date()
        let data = Data(event.data.utf8)
        switch event.event {
        case "message-start":
            streaming = true
            streamText = ""
            pendingDelta = ""
            activity = nil
        case "text-delta":
            if let payload = try? JSONDecoder().decode(DeltaPayload.self, from: data) {
                appendDelta(payload.delta)
            }
        case "tool":
            if let payload = try? JSONDecoder().decode(ToolPayload.self, from: data) {
                activity = payload.name
            }
        case "thinking":
            activity = "Thinking"
        case "queued":
            // Another turn holds the agent right now — the wait before
            // message-start is expected, not a stall. Tell the user.
            streaming = true
            activity = "Waiting for another task"
        case "message-end":
            let payload = try? JSONDecoder().decode(EndPayload.self, from: data)
            flushPendingDelta() // the streamText fallback must include the tail
            finalizeTurn(conversationID: conversationID, fullText: payload?.fullText ?? streamText)
        case "error":
            let payload = try? JSONDecoder().decode(ErrorPayload.self, from: data)
            AppLog.error("chat", "turn failed", ["message": payload?.message ?? "?"])
            streaming = false
            activity = nil
            errorMessage = payload?.message ?? "The turn failed."
        default:
            break
        }
    }

    /// Buffer a streamed text delta and schedule a coalesced flush. SwiftUI
    /// only sees `streamText` change ~8x/second regardless of delta rate, so
    /// the live markdown row re-renders at a bounded cadence.
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
        streamText += pendingDelta
        pendingDelta = ""
    }

    /// Mid-turn freeze breaker. The composer is disabled while `streaming` is
    /// true, so a lost `message-end` (stream died at the wrong moment, app
    /// suspend race, server restart) would freeze the chat forever. Transport
    /// death itself is SSEClient's watchdog's job — this one only reconciles
    /// STATE: if no SSE event lands for 30s during a turn, ask REST history
    /// whether the turn already finished, and adopt the result if so.
    private func startTurnWatchdog(conversationID: String) {
        turnWatchdog?.cancel()
        lastSSEEventAt = Date()
        turnWatchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard let self, !Task.isCancelled else { return }
                guard self.streaming, self.activeID == conversationID else { return }
                guard Date().timeIntervalSince(self.lastSSEEventAt) > 30 else { continue }
                // Silent too long — reconcile against server history.
                // Assistant messages persist only at turn end, so a plain
                // assistant message AFTER our watched user message proves the
                // turn is over. The after-check guards the queued case, where
                // the previous turn's trailing reply would otherwise satisfy
                // a naive "last is assistant" test.
                await self.loadMessages(conversationID)
                guard self.streaming, self.activeID == conversationID else { return }
                let history = self.messages
                let turnOver: Bool
                if let watched = self.watchedUserText,
                   let userIdx = history.lastIndex(where: { $0.role == "user" && $0.text == watched }) {
                    turnOver = history[(userIdx + 1)...].contains { $0.role == "assistant" && $0.kind == nil }
                } else {
                    // No watched message (409 turn_active path — someone else's
                    // turn): any trailing plain assistant reply means it ended.
                    turnOver = history.last?.role == "assistant" && history.last?.kind == nil
                }
                if turnOver {
                    AppLog.error("chat", "turn watchdog reconciled a lost message-end", [
                        "conversationID": conversationID,
                        "silentFor": "\(Int(Date().timeIntervalSince(self.lastSSEEventAt)))s",
                    ])
                    self.streaming = false
                    self.streamText = ""
                    self.activity = nil
                    return
                }
            }
        }
    }

    private func finalizeTurn(conversationID: String, fullText: String) {
        turnWatchdog?.cancel()
        turnWatchdog = nil
        watchedUserText = nil
        // Drop any unflushed delta tail — `fullText` is authoritative here.
        deltaFlushTask?.cancel()
        deltaFlushTask = nil
        pendingDelta = ""
        let wasAtBottom = viewIsAtBottom
        streaming = false
        streamText = ""
        activity = nil
        if !fullText.isEmpty {
            // Provisional bubble; replaced by canonical history right after.
            let isDuplicate = messages.last.map { $0.role == "assistant" && $0.text == fullText } ?? false
            if !isDuplicate {
                messages.append(ChatMessage(
                    id: "turn-\(Date().timeIntervalSince1970)",
                    role: "assistant", text: fullText,
                    createdAt: ISO8601DateFormatter().string(from: .now), kind: nil
                ))
            }
        }
        // Live row → provisional row shifts layout; keep the reader glued to
        // the end of the reply they were watching.
        if wasAtBottom { scrollToBottomSignal += 1 }
        // Reconcile with server history (real ids + tool/thinking rows).
        Task {
            await self.loadMessages(conversationID)
            await self.refreshConversations()
        }
    }

    private func reportIfNetwork(_ error: Error) {
        if let apiError = error as? APIError, case .network = apiError {
            connection?.reportReachability(false)
        }
    }
}
