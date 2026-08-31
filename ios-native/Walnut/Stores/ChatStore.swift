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
    @ObservationIgnored private var trackedTasks: [UUID: Task<Void, Never>] = [:]
    /// In-flight send()s. Kept separate from `trackedTasks` only because they
    /// return a value; they are cancelled by the same teardown path.
    @ObservationIgnored private var trackedSends: [UUID: Task<Bool, Never>] = [:]
    private var isActive = true
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

    /// Nav-bar title: the agent's name ("Walnut" for the Personal AI).
    var activeAgentName: String {
        activeAgent?.name ?? (activeAgentID == "general" ? "Walnut" : activeAgentID)
    }

    /// Sticky USER intent; geometry changes caused by content or keyboard do
    /// not alter it unless a user scroll phase crosses the hysteresis bounds.
    ///
    /// NOT observed on purpose: it is written from inside the scroll view's own
    /// layout pass (`ScrollBottomTracking`) and is only ever read imperatively —
    /// never from a view body. Observing it made every geometry sample invalidate
    /// the timeline that produced it, which spun the main thread forever (P0-2).
    @ObservationIgnored var bottomPinned = true
    /// Bumped after layout-shifting mutations that should restore pinned intent.
    private(set) var scrollToBottomSignal = 0

    /// First-paint pin guard. The first canonical load asks ScrollPosition to
    /// establish its bottom edge after variable-height rows have laid out.
    private var initialPaintDone = false

    var loadingList = false
    var loadingMessages = false
    var sending = false
    /// A turn is running on the active conversation (composer disabled).
    var streaming = false
    /// Accumulated live assistant text for the in-flight turn. Bounded like
    /// SessionConversationStore.liveText (LiveMarkdownWindow.boundedTail in
    /// flushPendingDelta) — retaining an unbounded reply makes every append +
    /// segments() O(reply), the 0x8BADF00D saturation mechanism.
    var streamText = ""
    /// True when streamText dropped its head to stay under the retention cap
    /// (drives the live row's "earlier output hidden" chip).
    private(set) var streamTextTruncated = false
    /// Delta coalescing (freeze fix): applying every SSE text-delta straight
    /// to `streamText` re-rendered the live markdown row PER DELTA — a full
    /// MarkdownParser.parse of the ever-growing reply on the main thread,
    /// dozens of times a second. Long replies saturated the main thread and
    /// froze the app. Deltas buffer here (non-observed via ObservationIgnored)
    /// and flush on a ~8Hz cadence instead.
    @ObservationIgnored private var pendingDelta = ""
    @ObservationIgnored private var deltaFlushTask: Task<Void, Never>?
    /// Images attached to messages sent in THIS app session, keyed by message
    /// text. Server history carries no image bytes, so when a canonical row
    /// replaces the optimistic bubble the thumbnails would otherwise vanish
    /// mid-conversation. Re-attached in `loadMessages`; bounded so a long
    /// session can't accumulate photo data.
    @ObservationIgnored private var sentImages: [(text: String, datas: [Data])] = []
    private static let maxRememberedSentImages = 12
    /// Latest tool/thinking status, e.g. "Read" — shown as an activity row.
    var activity: String?
    var errorMessage: String?
    /// True while the agent is blocked on a user_ask structured question.
    /// Set when the SSE `tool` event names user_ask; cleared on answer/stop/
    /// turn end. CONTRACT GAP: the v1 stream carries only the tool NAME — no
    /// question text or options — so the phone renders a generic answer card
    /// (free text) instead of option buttons.
    var pendingQuestion = false

    private static let pageSize = 50
    private static let cacheTail = 60

    // MARK: - Lifecycle

    init() {
        LifecycleHub.shared.register(self)
    }

    /// Cold launch lands on the MAIN agent with a fresh chat (user call,
    /// 2026-08-16): restoring the saved agent used to strand the app on a
    /// subagent (Mentor) whenever the main agent was unavailable, and opening
    /// into an old thread buried the composer under history. History stays one
    /// tap away (clock button); the conversation is created lazily on first
    /// send, so an untouched new chat never litters the server.
    func initialize() async {
        // Reactivate explicitly: Settings disconnect calls closeStream()
        // (isActive=false) and re-pairing runs initialize() in the SAME
        // foreground session — without this the chat tab is dead until the
        // next background/foreground cycle.
        isActive = true
        activeAgentID = Self.mainAgentID
        // Cache hydration is ASYNC (P0-1): decoding these on the MainActor was
        // part of the cold-start work that got a background/prewarm launch
        // killed for blowing the scene-update allowance.
        if let cachedAgents = await DiskCache.loadAsync([AgentSummary].self, key: "agents") {
            guard isActive else { return }
            agents = cachedAgents
        }
        if let cachedList = await DiskCache.loadAsync([ConversationSummary].self, key: conversationsCacheKey) {
            guard isActive else { return }
            conversations = cachedList
        }
        guard isActive else { return }
        // New chat is the resting state — no saved-conversation restore, no
        // fall-through to the most recent thread.
        select(nil)
        await refreshAgents()
        await refreshConversations()
    }

    /// The server marks the main agent with `isMain` (id "general"); this is
    /// the same fallback id the API defaults to when none is sent.
    static let mainAgentID = "general"

    /// Per-agent persistence keys — each agent remembers its own thread.
    private var activeConversationKey: String { "walnut.activeConversation.\(activeAgentID)" }
    private var conversationsCacheKey: String { "conversations-\(activeAgentID)" }

    func refreshAgents() async {
        guard isActive else { return }
        do {
            let fetched = try await api.agents()
            guard isActive, !Task.isCancelled else { return }
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
        conversations = []
        messages = []
        hasOlder = false
        if let saved = UserDefaults.standard.string(forKey: activeConversationKey) {
            select(saved)
        }
        trackTask { [weak self] in
            guard let self else { return }
            // Cached list first (off-main), then the network truth. Only adopt
            // the cache while nothing canonical has landed.
            let key = self.conversationsCacheKey
            if let cached = await DiskCache.loadAsync([ConversationSummary].self, key: key),
               self.conversations.isEmpty, key == self.conversationsCacheKey {
                self.conversations = cached
                if self.activeID == nil { self.select(cached.first?.id) }
            }
            await self.refreshConversations()
            if self.activeID == nil || !self.conversations.contains(where: { $0.id == self.activeID }) {
                self.select(self.conversations.first?.id)
            }
        }
    }

    func refreshConversations() async {
        guard isActive else { return }
        loadingList = true
        defer { loadingList = false }
        do {
            let agentID = activeAgentID
            let fetched = try await api.conversations(agentID: agentID)
            guard isActive, !Task.isCancelled else { return }
            connection?.reportReachability(true, source: "chat-rest")
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
        streamTextTruncated = false
        activity = nil
        errorMessage = nil
        initialPaintDone = false
        messages = []
        connectStream()
        if let id {
            // Cached tail hydrates OFF-MAIN (P0-1) and only wins while nothing
            // canonical has landed for this conversation yet — loadMessages runs
            // concurrently and its result is authoritative whichever finishes
            // first.
            trackTask { [weak self] in
                guard let self else { return }
                if let cached = await DiskCache.loadAsync([ChatMessage].self, key: "messages-\(id)"),
                   !cached.isEmpty, self.activeID == id,
                   self.messages.isEmpty, !self.initialPaintDone {
                    self.messages = cached
                    // Cached rows landed — force the bottom rows to instantiate
                    // (the blank-list bug hits the cold-launch cache path
                    // hardest).
                    if self.isActive { self.scrollToBottomSignal += 1 }
                }
            }
            trackTask { [weak self] in await self?.loadMessages(id) }
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
        guard isActive else { return }
        loadingMessages = true
        defer { loadingMessages = false }
        do {
            let agentID = activeAgentID
            let fetched = try await api.messages(conversationID: id, agentID: agentID, limit: Self.pageSize)
            guard isActive, !Task.isCancelled else { return }
            connection?.reportReachability(true, source: "chat-rest", endpoint: "/api/v1/conversations/messages")
            guard id == activeID, agentID == activeAgentID else { return }
            // Carry local-only bubbles across the replace — server history
            // doesn't know about them and a refetch must never erase them.
            // Besides failed/in-flight optimistic bubbles, this keeps
            // SOLIDIFIED local echoes (the `local-…` user bubble after its 202,
            // and finalizeTurn's `turn-…` provisional reply) that the fetch
            // doesn't contain yet: a cloud replica's GET /messages serves a
            // LAGGING copy until git-sync converges, and adopting that copy
            // wholesale erased the user's just-sent message AND the fresh
            // reply right after the turn ended (2026-08-23 dogfood round 10).
            let localOnly = Self.carryLocalRows(current: messages, fetched: fetched)
            let wasAtBottom = bottomPinned
            let changed = fetched.count + localOnly.count != messages.count
                || fetched.last?.id != messages.dropLast(localOnly.count).last?.id
            MainWork.track("chat.loadMessages", count: fetched.count) {
                messages = Self.reattachSentImages(to: fetched, from: sentImages) + localOnly
            }
            // Freeze-report context: rows handed to SwiftUI for layout.
            FreezeContext.shared.setHistoryRows(messages.count)
            hasOlder = fetched.count >= Self.pageSize
            // Replacing rows with canonical ids/heights displaces the viewport
            // once the bottom anchor's auto-pin has lapsed (any manual scroll)
            // — glue the reader back only if they were already at the bottom.
            // The FIRST load always pins: see initialPaintDone (blank-list fix).
            if isActive && (!initialPaintDone || (changed && wasAtBottom)) { scrollToBottomSignal += 1 }
            initialPaintDone = true
            DiskCache.save(Array(fetched.suffix(Self.cacheTail)), key: "messages-\(id)")
        } catch {
            reportIfNetwork(error)
        }
    }

    /// How long a solidified local echo (the user bubble after its 202, the
    /// provisional reply after message-end) survives refetches that don't
    /// contain its canonical row yet. Replica sync lag is ~30-60s; well past
    /// that, dropping the echo beats risking a stale duplicate forever.
    /// Failed/pending bubbles never expire — they are the only copy of the text.
    static let localEchoTTL: TimeInterval = 10 * 60

    /// Which of the CURRENT rows must survive a canonical refetch. Three classes:
    ///  - pending/failed bubbles: kept unconditionally (unsent text, no TTL);
    ///  - solidified `local-…` user echoes whose canonical row the fetch does
    ///    not carry YET — a cloud replica's GET /messages serves a copy that
    ///    lags git-sync, and adopting it wholesale erased the user's just-sent
    ///    message right after every relayed turn (2026-08-23 dogfood);
    ///  - `turn-…` provisional replies, retired only once the fetch's LAST
    ///    plain assistant row differs from the last one we already held
    ///    canonically — proof the canonical reply landed. Matching the reply's
    ///    text against the echo would be fragile (the server normalizes text —
    ///    entity-ref stripping etc. — so the SSE fullText and the canonical row
    ///    need not be byte-identical); two canonical fetches, by contrast, are
    ///    normalization-consistent with each other.
    ///
    /// User-echo matching is COUNT-aware per (role, text): a fetch only absorbs
    /// an echo when it carries MORE matching rows than the canonical rows we
    /// already had — an identical older message ("ok", "continue") can never
    /// absorb the new echo and vanish it. Internal for WalnutTests.
    nonisolated static func carryLocalRows(
        current: [ChatMessage], fetched: [ChatMessage], now: Date = Date()
    ) -> [ChatMessage] {
        func key(_ m: ChatMessage) -> String { "\(m.role)|\(m.text)" }
        let isEcho: (ChatMessage) -> Bool = {
            $0.id.hasPrefix("local-") || $0.id.hasPrefix("turn-")
        }
        func lastPlainAssistant(_ rows: [ChatMessage], skipEchoes: Bool) -> ChatMessage? {
            rows.last(where: {
                $0.role == "assistant" && $0.kind == nil && (!skipEchoes || !isEcho($0))
            })
        }
        // Budget = canonical rows the fetch ADDS beyond what we already had.
        var budget: [String: Int] = [:]
        for row in fetched { budget[key(row), default: 0] += 1 }
        for row in current where !isEcho(row) {
            let k = key(row)
            if let b = budget[k], b > 0 { budget[k] = b - 1 }
        }
        // Did the fetch advance past our canonical view of the reply stream?
        // Positional ids change per fetch, so compare (text, createdAt).
        let knownReply = lastPlainAssistant(current, skipEchoes: true)
        let fetchedReply = lastPlainAssistant(fetched, skipEchoes: false)
        let replyAdvanced: Bool
        if let fetchedReply {
            replyAdvanced = knownReply == nil
                || fetchedReply.text != knownReply!.text
                || fetchedReply.createdAt != knownReply!.createdAt
        } else {
            replyAdvanced = false
        }
        var retireBudget = replyAdvanced ? 1 : 0
        let parseISO = ISO8601DateFormatter()
        var out: [ChatMessage] = []
        for row in current {
            if row.failed == true || row.pending == true {
                out.append(row)
                continue
            }
            guard isEcho(row) else { continue }
            // TTL backstop: a stray echo (compaction rewrote history, tail
            // window slid) must self-heal rather than duplicate forever.
            if let created = parseISO.date(from: row.createdAt),
               now.timeIntervalSince(created) > localEchoTTL {
                continue
            }
            if row.id.hasPrefix("turn-") {
                if retireBudget > 0 {
                    retireBudget -= 1 // canonical reply landed — echo retires
                } else {
                    out.append(row)
                }
                continue
            }
            let k = key(row)
            if let b = budget[k], b > 0 {
                budget[k] = b - 1 // canonical row replaces this echo
            } else {
                out.append(row) // fetch is stale — keep the echo
            }
        }
        return out
    }

    func loadOlder() async {
        guard isActive, let id = activeID, hasOlder, !loadingMessages,
              let oldest = messages.first(where: { $0.pending != true })
        else { return }
        loadingMessages = true
        defer { loadingMessages = false }
        do {
            let older = try await api.messages(conversationID: id, agentID: activeAgentID, limit: Self.pageSize, before: oldest.id)
            guard isActive, !Task.isCancelled, id == activeID else { return }
            messages.insert(contentsOf: older, at: 0)
            hasOlder = older.count >= Self.pageSize
        } catch {
            reportIfNetwork(error)
        }
    }

    // MARK: - Send flow (POST → 202 {turnId} → SSE deltas)

    /// Public entry point. The actual work runs inside a TRACKED task so
    /// `closeStream()` (backgrounding, disconnect) cancels it like every other
    /// store task — an untracked send kept a network round-trip alive across
    /// suspension and then wrote UI state into a store that had already been
    /// torn down.
    /// Would `send` take a new turn right now, or refuse it having kept NOTHING?
    ///
    /// Exposed because the difference is invisible in `send`'s Bool and the caller
    /// sometimes has to know: a refusal here appends no bubble at all, while every
    /// failure PAST this point runs `markSendFailed` first, so the text survives as
    /// a retryable red bubble. A caller holding the only copy of some text (the
    /// voice transcript — its audio is already deleted) must rescue it on the first
    /// and must not on the second, or the same sentence exists twice and can be
    /// sent twice. See `ComposerBar.voiceRescueReason`.
    var acceptsNewTurn: Bool { isActive && !sending && !streaming }

    @discardableResult
    func send(_ text: String, images: [SelectedImage] = []) async -> Bool {
        // Agent blocked on a structured question: route the composer text to
        // the answer endpoint (mirrors the web chat's interception — posting
        // a new message would 409 turn_active and deadlock the flow).
        if pendingQuestion, !text.isEmpty {
            return await answerQuestion(text)
        }
        guard acceptsNewTurn else { return false }
        let id = UUID()
        let task = Task { @MainActor [weak self] in
            guard let self else { return false }
            return await self.performSend(text, images: images)
        }
        trackedSends[id] = task
        let ok = await task.value
        trackedSends[id] = nil
        return ok
    }

    /// Mark the optimistic bubble as a failed one (tap to retry) — the text and
    /// its images must never disappear, whatever went wrong.
    private func markSendFailed(_ messageID: String) {
        guard let idx = messages.firstIndex(where: { $0.id == messageID }) else { return }
        messages[idx].pending = false
        messages[idx].failed = true
    }

    private func performSend(_ text: String, images: [SelectedImage]) async -> Bool {
        sending = true
        errorMessage = nil

        let jpegDatas = images.map(\.jpegData)
        var convID = activeID
        var optimistic = ChatMessage(
            id: "local-\(Date().timeIntervalSince1970)",
            role: "user", text: text, createdAt: ISO8601DateFormatter().string(from: .now), kind: nil
        )
        optimistic.pending = true
        // Carry thumbnails so the bubble shows them immediately and a failed
        // send retains them for retry (the store owns no-loss preservation).
        if !jpegDatas.isEmpty { optimistic.localImages = jpegDatas }

        // Append FIRST — even payload preparation or createConversation failure
        // must leave the text + images on screen as a failed bubble, never lose them.
        messages.append(optimistic)
        // Sending explicitly accepts a re-pin: the user wants to see their own
        // message land even if they were reading history.
        bottomPinned = true
        if isActive { scrollToBottomSignal += 1 }
        do {
            let payloads = await Self.buildImagePayloads(jpegDatas)
            // Every await is a suspension point where the store can be torn
            // down (background / disconnect). Writing `streaming = true` after
            // that teardown is exactly what leaves the composer frozen on
            // resume, so bail out at each hop instead — the bubble stays as a
            // retryable failed one.
            guard isActive, !Task.isCancelled else {
                sending = false
                markSendFailed(optimistic.id)
                return false
            }
            if convID == nil {
                let created = try await api.createConversation(agentID: activeAgentID)
                guard isActive, !Task.isCancelled else {
                    sending = false
                    markSendFailed(optimistic.id)
                    return false
                }
                convID = created
                activeID = created
                UserDefaults.standard.set(created, forKey: activeConversationKey)
                connectStream()
            }
            guard let convID else {
                sending = false
                markSendFailed(optimistic.id)
                return false
            }
            _ = try await api.sendMessage(conversationID: convID, agentID: activeAgentID, text: text, images: payloads)
            // Accepted by the server. If the store went inactive meanwhile the
            // turn is genuinely running — do NOT mark it failed (that would
            // duplicate the message on retry); just skip the local UI state,
            // which resumeStream() rebuilds from canonical history.
            guard isActive, !Task.isCancelled else {
                sending = false
                return true
            }
            connection?.reportReachability(true, source: "chat-rest")
            // Solidify the bubble; message-start arrives on SSE shortly.
            if let idx = messages.firstIndex(where: { $0.id == optimistic.id }) {
                messages[idx].pending = false
            }
            rememberSentImages(text: text, datas: jpegDatas)
            sending = false
            streaming = true
            streamText = ""
            streamTextTruncated = false
            activity = nil
            watchedUserText = text
            startTurnWatchdog(conversationID: convID)
            return true
        } catch {
            sending = false
            // Cancelled/suspended sends settle silently but must NOT leave a
            // forever-pending bubble: the draft is already cleared, so the
            // failed bubble (tap to retry) is the only copy of the text.
            if !isActive || (error as? APIError)?.isCancelled == true {
                markSendFailed(optimistic.id)
                return false
            }
            if let apiError = error as? APIError, apiError.isTurnActive {
                // Another turn is running — keep the text as a failed bubble
                // (the draft is already cleared) so it can be retried after
                // message-end, and gate sends until then.
                markSendFailed(optimistic.id)
                streaming = true
                watchedUserText = nil
                if let convID { startTurnWatchdog(conversationID: convID) }
                errorMessage = "The assistant is already replying — tap the message to retry when it finishes."
            } else {
                // KEEP the bubble, marked failed — the user's text must never
                // vanish on a network error. Tap to retry / copy / delete.
                markSendFailed(optimistic.id)
                reportIfNetwork(error)
                errorMessage = error.localizedDescription
            }
            return false
        }
    }

    /// Remember a sent message's image bytes so the canonical server row that
    /// replaces the optimistic bubble can still show its thumbnails.
    private func rememberSentImages(text: String, datas: [Data]) {
        guard !datas.isEmpty else { return }
        sentImages.removeAll { $0.text == text }
        sentImages.append((text: text, datas: datas))
        if sentImages.count > Self.maxRememberedSentImages {
            sentImages.removeFirst(sentImages.count - Self.maxRememberedSentImages)
        }
    }

    /// Re-attach remembered image bytes to canonical user rows. Matched on text
    /// because the server assigns its own id — the optimistic `local-…` id never
    /// survives the swap.
    private nonisolated static func reattachSentImages(
        to fetched: [ChatMessage], from remembered: [(text: String, datas: [Data])]
    ) -> [ChatMessage] {
        guard !remembered.isEmpty else { return fetched }
        var out = fetched
        for index in out.indices where out[index].isUser && out[index].localImages == nil {
            let text = out[index].text
            if let match = remembered.last(where: { $0.text == text }) {
                out[index].localImages = match.datas
            }
        }
        return out
    }

    /// Sequential, budgeted, off-MainActor — see SelectedImage.buildPayloads.
    private nonisolated static func buildImagePayloads(_ datas: [Data]) async -> [ImagePayload] {
        await SelectedImage.buildPayloads(datas)
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
        guard isActive else { return }
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
                    // SSE churn is diagnostic only; ConnectionStore never counts
                    // it toward the REST transport failure gate.
                    self?.connection?.reportReachability(ok, source: "chat-sse")
                }
            }
        )
        sse?.start()
    }

    func closeStream() {
        isActive = false
        sse?.stop()
        sse = nil
        turnWatchdog?.cancel()
        turnWatchdog = nil
        deltaFlushTask?.cancel()
        deltaFlushTask = nil
        pendingDelta = ""
        cancelTrackedTasks()
        sending = false
        streaming = false
        activity = nil
    }

    private func resumeStream() {
        guard !isActive else { return }
        isActive = true
        connectStream()
        if let id = activeID {
            trackTask { [weak self] in await self?.loadMessages(id) }
        }
    }

    private struct DeltaPayload: Codable { let delta: String }
    private struct ToolPayload: Codable { let name: String; let detail: String? }
    private struct EndPayload: Codable { let turnId: String; let fullText: String }
    private struct ErrorPayload: Codable { let message: String }

    /// Equality-gated writes for the per-SSE-event flags — same fix as
    /// SessionConversationStore.setStreaming/setActivity (build-36 field
    /// freeze): @Observable has no same-value suppression, and the Personal AI
    /// stream repeats `thinking` at whatever rate the agent emits, so an
    /// unconditional `activity = "Thinking"` invalidates every body that
    /// reads it (ChatView reads `streaming` in its ScrollView body) at
    /// event rate. Route ALL streaming/activity writes through these.
    private func setStreaming(_ value: Bool) {
        if streaming != value { streaming = value }
    }

    private func setActivity(_ value: String?) {
        if activity != value { activity = value }
    }

    /// Test seam: WalnutTests drives the REAL handler (it is private because
    /// its guard needs activeID; tests set that up first). Production code
    /// must keep calling `handle` via the SSE callback only.
    func handleForTesting(_ event: SSEEvent, conversationID: String) {
        handle(event, conversationID: conversationID)
    }

    private func handle(_ event: SSEEvent, conversationID: String) {
        guard isActive, conversationID == activeID else { return }
        lastSSEEventAt = Date()
        let data = Data(event.data.utf8)
        switch event.event {
        case "message-start":
            setStreaming(true)
            streamText = ""
            streamTextTruncated = false
            pendingDelta = ""
            setActivity(nil)
        case "text-delta":
            if let payload = try? JSONDecoder().decode(DeltaPayload.self, from: data) {
                appendDelta(payload.delta)
            }
        case "tool":
            if let payload = try? JSONDecoder().decode(ToolPayload.self, from: data) {
                setActivity(payload.detail.map { "\(payload.name) · \($0)" } ?? payload.name)
                // The agent is now blocked on a structured question — surface
                // the answer card. (The stream carries only the tool name; the
                // question text/options are not on the v1 wire.)
                if payload.name == "user_ask" { pendingQuestion = true }
            }
        case "thinking":
            setActivity("Thinking")
        case "queued":
            // Another turn holds the agent right now — the wait before
            // message-start is expected, not a stall. Tell the user.
            setStreaming(true)
            setActivity("Waiting for another task")
        case "message-end":
            let payload = try? JSONDecoder().decode(EndPayload.self, from: data)
            flushPendingDelta() // the streamText fallback must include the tail
            // A truncated streamText lost the reply's head — as a provisional
            // bubble it would render a mid-sentence fragment. Skip it and let
            // loadMessages paint the canonical row (fullText, when present,
            // is server-authoritative and unaffected).
            let fallback = streamTextTruncated ? "" : streamText
            finalizeTurn(conversationID: conversationID, fullText: payload?.fullText ?? fallback)
        case "error":
            let payload = try? JSONDecoder().decode(ErrorPayload.self, from: data)
            AppLog.error("chat", "turn failed", ["message": payload?.message ?? "?"])
            streaming = false
            activity = nil
            pendingQuestion = false
            errorMessage = Self.readableTurnError(payload?.message)
        default:
            break
        }
    }

    /// Turn out a human-readable banner for a provider rejection. A raw
    /// `400 messages.62.content.3.image.source.base64.data: …` string tells the
    /// user nothing and, worse, hides the fact that it is an ATTACHMENT problem
    /// they can act on. The server now clamps image dimensions on both ingest
    /// and replay, so this path should be unreachable for new uploads; the
    /// friendly text exists for old servers / other provider image rejections.
    static func readableTurnError(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "The turn failed." }
        let lower = raw.lowercased()
        if lower.contains("image") && (lower.contains("dimension") || lower.contains("exceed") || lower.contains("too large")) {
            return "An attached image was rejected by the model (too large). Update the server so it downscales attachments, then try again."
        }
        return raw
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
        MainWork.track("chat.deltaFlush", count: pendingDelta.utf8.count) {
            flushPendingDeltaTracked()
        }
    }

    private func flushPendingDeltaTracked() {
        // Trim before appending so the append never copies a giant string
        // (same bound as SessionConversationStore.flushPendingDelta).
        let (bounded, trimmed) = streamTextBound.bound(streamText)
        if trimmed {
            streamText = bounded
            streamTextTruncated = true
        }
        streamText += pendingDelta
        pendingDelta = ""
        // Freeze-report context (counts only, O(1) utf8 length; ~8Hz flush rate).
        FreezeContext.shared.setLiveText(chars: streamText.utf8.count, truncated: streamTextTruncated)
        reassertPinnedFollow()
    }

    /// Hysteresis state for the streamText retention cap (see TailBound).
    @ObservationIgnored private var streamTextBound = LiveMarkdownWindow.TailBound()

    /// Last time a streaming flush re-asserted the bottom edge — throttles the
    /// re-assert so it can't run at the full 8Hz flush rate.
    @ObservationIgnored private var lastPinReassertAt: Date?
    /// Must stay comfortably ABOVE the view's 250ms programmatic-geometry freeze
    /// (`MessageListView.scrollToBottom`). Re-asserting faster than that would
    /// keep geometry frozen for most of a streaming turn, and a user trying to
    /// scroll back into history mid-reply would find their drags ignored (intent
    /// tracking is deliberately suppressed while frozen). At 700ms there is
    /// always a ~450ms clear window per cycle — hundreds of geometry samples —
    /// for a real drag to cross the unpin threshold, after which `bottomPinned`
    /// is false and this stops firing entirely.
    private static let pinReassertInterval: TimeInterval = 0.7

    /// Keep a PINNED reader glued to the bottom as streamed content grows.
    ///
    /// `ScrollPosition`'s bottom-edge association is not permanent: once the user
    /// has scrolled manually, growing the content no longer moves the viewport,
    /// so a reader who scrolled back to within the re-pin threshold (intent =
    /// pinned again) simply stopped following the reply — the classic "it follows
    /// at 0pt and above 200pt but not in between". Re-asserting the edge is cheap
    /// and idempotent, so do it from the flush.
    ///
    /// This lives on the STORE side on purpose. `ScrollBottomTracking`'s geometry
    /// callback runs inside the scroll view's layout pass; writing observable
    /// state from there does not converge and spins the main thread (P0-2), so
    /// the re-assert must never be driven from that callback.
    private func reassertPinnedFollow() {
        guard isActive, streaming, bottomPinned else { return }
        let now = Date()
        if let last = lastPinReassertAt, now.timeIntervalSince(last) < Self.pinReassertInterval {
            return
        }
        lastPinReassertAt = now
        scrollToBottomSignal += 1
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
                guard let self, self.isActive, !Task.isCancelled else { return }
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
                let turnOver = Self.turnSettled(history: self.messages, watched: self.watchedUserText)
                if turnOver {
                    AppLog.error("chat", "turn watchdog reconciled a lost message-end", [
                        "conversationID": conversationID,
                        "silentFor": "\(Int(Date().timeIntervalSince(self.lastSSEEventAt)))s",
                    ])
                    self.streaming = false
                    self.streamText = ""
                    self.streamTextTruncated = false
                    self.activity = nil
                    return
                }
            }
        }
    }

    /// Watchdog reconcile verdict: does fetched history PROVE the watched turn
    /// is over? Assistant messages persist only at turn end, so a plain
    /// assistant row AFTER our watched user message is proof. When the watched
    /// user message is MISSING from the fetch, the copy is stale (a replica
    /// lagging git-sync) or the tail window slid past it — never settle from
    /// evidence that predates our own send: the PREVIOUS turn's trailing reply
    /// would satisfy the naive last-is-assistant check and clear `streaming`
    /// mid-turn (2026-08-23 dogfood round 10). The last-is-assistant fallback
    /// is only for the 409 turn_active path, where there IS no watched text
    /// (someone else's turn). Internal for WalnutTests.
    nonisolated static func turnSettled(history: [ChatMessage], watched: String?) -> Bool {
        guard let watched else {
            return history.last?.role == "assistant" && history.last?.kind == nil
        }
        guard let userIdx = history.lastIndex(where: { $0.role == "user" && $0.text == watched }) else {
            return false
        }
        return history[(userIdx + 1)...].contains { $0.role == "assistant" && $0.kind == nil }
    }

    private func finalizeTurn(conversationID: String, fullText: String) {
        turnWatchdog?.cancel()
        turnWatchdog = nil
        watchedUserText = nil
        // Drop any unflushed delta tail — `fullText` is authoritative here.
        deltaFlushTask?.cancel()
        deltaFlushTask = nil
        pendingDelta = ""
        let wasAtBottom = bottomPinned
        streaming = false
        streamText = ""
        streamTextTruncated = false
        activity = nil
        pendingQuestion = false
        FreezeContext.shared.setLiveText(chars: 0, truncated: false)
        FreezeContext.shared.note("turn-end")
        if !fullText.isEmpty {
            // Provisional bubble; replaced by canonical history right after.
            // Duplicate check normalizes entity refs on BOTH sides: an SSE ring
            // replay (reconnect) re-delivers the previous turn's message-end,
            // and old servers sent its fullText RAW (<task-ref …/>) while the
            // canonical row is stripped — a byte compare saw "different" and
            // re-materialized the old reply as a permanent extra bubble
            // (2026-08-23 dogfood round 13).
            let normalized = MarkdownParser.replaceEntityRefs(fullText, bold: false)
            let isDuplicate = messages.last.map {
                $0.role == "assistant"
                    && MarkdownParser.replaceEntityRefs($0.text, bold: false) == normalized
            } ?? false
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
        if isActive && wasAtBottom { scrollToBottomSignal += 1 }
        // Reconcile with server history (real ids + tool/thinking rows).
        trackTask { [weak self] in
            await self?.loadMessages(conversationID)
            await self?.refreshConversations()
        }
    }

    // MARK: - Conversation management (Wave 1 — stop / rename / pin / delete)

    /// Stop the agent's active turn(s). The server aborts ALL turns for this
    /// agent and cancels any pending structured question; the SSE `error`
    /// event (or watchdog reconcile) settles the local streaming state, but
    /// clear it optimistically so the composer unfreezes at once.
    func stopTurn() async {
        guard let id = activeID else { return }
        do {
            let result = try await api.stopConversation(id: id, agentID: activeAgentID)
            AppLog.info("chat", "turn stopped", ["conversationID": id, "stopped": String(result.stopped)])
            streaming = false
            streamText = ""
            streamTextTruncated = false
            activity = nil
            pendingQuestion = false
            turnWatchdog?.cancel()
            turnWatchdog = nil
            // Reconcile: the interrupted turn's partial output persists at abort.
            trackTask { [weak self] in await self?.loadMessages(id) }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Answer the pending structured question with free text. The blocked
    /// turn resumes and its continuation streams over the SAME SSE turn.
    /// CONTRACT GAP: /answer wants header-keyed answers but no v1 surface
    /// exposes the pending question's headers — send the text under BOTH
    /// default header spellings ("Answer" = single question, "Q1" = first of
    /// several); extra keys are ignored server-side. An agent-custom header
    /// resolves to "(no answer)" but still unblocks the turn (the agent can
    /// re-ask), which beats a deadlocked composer.
    func answerQuestion(_ text: String) async -> Bool {
        // Preserved exactly: "did this unblock the question", which is what every
        // existing caller asks. Only `.failedKeepingNothing` is a no.
        await answerQuestionReportingOutcome(text) != .failedKeepingNothing
    }

    /// What happened to THE ANSWER TEXT, which is not the same question as what
    /// happened to the QUESTION — and conflating them silently dropped words.
    ///
    /// A 409 means somebody resolved the question elsewhere first. For the question
    /// that is success (it is gone, the turn is unblocked, and the composer must
    /// stop offering to answer it), so `answerQuestion` rightly says true. But OUR
    /// text was never delivered and nothing anywhere kept it: no bubble, no draft.
    /// For typed text that is survivable (it is still on screen); for DICTATED text
    /// the audio was deleted the moment transcription succeeded, so this string was
    /// the only copy and "true" was how it got thrown away.
    enum AnswerOutcome: Equatable {
        /// Delivered and persisted server-side; history reloads to show it.
        case delivered
        /// Resolved elsewhere first (409). The turn moved on without these words.
        case supersededKeepingNothing
        /// No question to answer, or the POST failed. Nothing was appended.
        case failedKeepingNothing
    }

    func answerQuestionReportingOutcome(_ text: String) async -> AnswerOutcome {
        guard let id = activeID, pendingQuestion else { return .failedKeepingNothing }
        do {
            try await api.answerConversationQuestion(
                id: id, agentID: activeAgentID, answers: ["Answer": text, "Q1": text]
            )
            pendingQuestion = false
            setActivity(nil)
            // The answer is persisted server-side as a user entry; reload so
            // it appears in history right away.
            trackTask { [weak self] in await self?.loadMessages(id) }
            return .delivered
        } catch let error as APIError where error.isConflict {
            // Question already answered/cancelled elsewhere.
            pendingQuestion = false
            return .supersededKeepingNothing
        } catch {
            errorMessage = error.localizedDescription
            return .failedKeepingNothing
        }
    }

    /// Rename a conversation (PATCH title). Optimistic list update + reload.
    func renameConversation(_ id: String, title: String) async -> String? {
        do {
            _ = try await api.patchConversation(id: id, agentID: activeAgentID, title: title)
            await refreshConversations()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Pin/unpin a conversation. The v1 list projection carries no pinned
    /// flag (server sorts by recency), so this is fire-and-refresh.
    func setConversationPinned(_ id: String, pinned: Bool) async -> String? {
        do {
            _ = try await api.patchConversation(id: id, agentID: activeAgentID, pinned: pinned)
            await refreshConversations()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Delete a conversation. The MAIN conversation answers 409 conflict —
    /// surfaced as a readable error. Deleting the active one falls back to
    /// the most recent remaining conversation.
    func deleteConversation(_ id: String) async -> String? {
        do {
            try await api.deleteConversation(id: id, agentID: activeAgentID)
            conversations.removeAll { $0.id == id }
            DiskCache.save(conversations, key: conversationsCacheKey)
            if activeID == id {
                select(conversations.first?.id)
            }
            await refreshConversations()
            return nil
        } catch let error as APIError where error.isConflict {
            return "The main conversation can't be deleted — it receives notifications and scheduled routines."
        } catch {
            return error.localizedDescription
        }
    }

    private func reportIfNetwork(_ error: Error) {
        guard isActive else { return }
        if let apiError = error as? APIError {
            if apiError.isCancelled { return }
            if case .network = apiError {
                connection?.reportReachability(false, source: "chat-rest", error: error)
            }
        }
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
        for task in trackedSends.values { task.cancel() }
        trackedSends.removeAll()
    }
}

extension ChatStore: LifecycleSuspendable {
    func suspendForBackground() { closeStream() }
    func resumeForForeground() { resumeStream() }
}
