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

    var loadingList = false
    var loadingMessages = false
    var sending = false
    /// A turn is running on the active conversation (composer disabled).
    var streaming = false
    /// Accumulated live assistant text for the in-flight turn.
    var streamText = ""
    /// Latest tool/thinking status, e.g. "Read" — shown as an activity row.
    var activity: String?
    var errorMessage: String?

    private static let pageSize = 50
    private static let cacheTail = 60

    // MARK: - Lifecycle

    /// Load cache, pick the most recent conversation, refresh from network.
    func initialize() async {
        if let cachedList: [ConversationSummary] = DiskCache.load([ConversationSummary].self, key: "conversations") {
            conversations = cachedList
        }
        if let saved = UserDefaults.standard.string(forKey: "walnut.activeConversation") {
            select(saved)
        }
        await refreshConversations()
        if activeID == nil || !conversations.contains(where: { $0.id == activeID }) {
            select(conversations.first?.id)
        }
    }

    func refreshConversations() async {
        loadingList = true
        defer { loadingList = false }
        do {
            conversations = try await api.conversations()
            connection?.reportReachability(true)
            DiskCache.save(conversations, key: "conversations")
        } catch {
            reportIfNetwork(error)
        }
    }

    /// Switch the active conversation: render cache instantly, reconnect SSE,
    /// then revalidate messages from the network.
    func select(_ id: String?) {
        guard id != activeID || sse == nil else { return }
        activeID = id
        UserDefaults.standard.set(id, forKey: "walnut.activeConversation")
        turnWatchdog?.cancel()
        turnWatchdog = nil
        streaming = false
        streamText = ""
        activity = nil
        errorMessage = nil
        messages = id.flatMap { DiskCache.load([ChatMessage].self, key: "messages-\($0)") } ?? []
        connectStream()
        if let id {
            Task { await self.loadMessages(id) }
        }
    }

    func startNewConversation() {
        // Lazy: created server-side on first send.
        select(nil)
    }

    var activeTitle: String {
        guard let activeID else { return "Walnut" }
        return conversations.first(where: { $0.id == activeID })?.title ?? "Walnut"
    }

    // MARK: - Messages

    func loadMessages(_ id: String) async {
        loadingMessages = true
        defer { loadingMessages = false }
        do {
            let fetched = try await api.messages(conversationID: id, limit: Self.pageSize)
            connection?.reportReachability(true)
            guard id == activeID else { return }
            messages = fetched
            hasOlder = fetched.count >= Self.pageSize
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
            let older = try await api.messages(conversationID: id, limit: Self.pageSize, before: oldest.id)
            guard id == activeID else { return }
            messages.insert(contentsOf: older, at: 0)
            hasOlder = older.count >= Self.pageSize
        } catch {
            reportIfNetwork(error)
        }
    }

    // MARK: - Send flow (POST → 202 {turnId} → SSE deltas)

    @discardableResult
    func send(_ text: String) async -> Bool {
        guard !sending, !streaming else { return false }
        sending = true
        errorMessage = nil

        var convID = activeID
        var optimistic = ChatMessage(
            id: "local-\(Date().timeIntervalSince1970)",
            role: "user", text: text, createdAt: ISO8601DateFormatter().string(from: .now), kind: nil
        )
        optimistic.pending = true

        do {
            if convID == nil {
                let created = try await api.createConversation()
                convID = created
                activeID = created
                UserDefaults.standard.set(created, forKey: "walnut.activeConversation")
                connectStream()
            }
            guard let convID else {
                sending = false
                return false
            }
            messages.append(optimistic)
            _ = try await api.sendMessage(conversationID: convID, text: text)
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
            messages.removeAll { $0.pending == true }
            sending = false
            if let apiError = error as? APIError, apiError.isTurnActive {
                // Contract: disable composer until message-end arrives on SSE.
                streaming = true
                watchedUserText = nil
                if let convID { startTurnWatchdog(conversationID: convID) }
                errorMessage = "The assistant is already replying — wait for it to finish."
            } else {
                reportIfNetwork(error)
                errorMessage = error.localizedDescription
            }
            return false
        }
    }

    // MARK: - SSE

    func connectStream() {
        sse?.stop()
        sse = nil
        guard let convID = activeID,
              let base = AppConfig.serverURL,
              let token = AppConfig.token,
              let url = URL(string: "\(base.absoluteString)/api/v1/conversations/\(convID)/stream")
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
            activity = nil
        case "text-delta":
            if let payload = try? JSONDecoder().decode(DeltaPayload.self, from: data) {
                streamText += payload.delta
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
