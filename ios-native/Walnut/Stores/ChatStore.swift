import Foundation
import Observation

/// The ONE network read whose APPLY-TIME ordering this store has to get right:
/// a conversation's page of messages. Injectable so WalnutTests can hold
/// conversation A's fetch open, switch to conversation B, and only then release
/// it — the ordering that painted A's messages under B's title cannot be staged
/// through a live URLSession.
///
/// Same shape as `WalnutTaskTransport`: `WalnutAPI` already has the method, so
/// conformance is an empty extension.
protocol ChatMessagesTransport {
    func messages(
        conversationID: String, agentID: String, limit: Int, before: String?
    ) async throws -> [ChatMessage]
}

extension WalnutAPI: ChatMessagesTransport {}

/// The two WRITES the send flow makes, behind a seam for the same reason reads
/// have one: the send queue's whole promise is "nothing reaches the server until
/// the running turn ends", and a claim about what did NOT go out cannot be made
/// against a live URLSession. A scripted transport is also the only way to stage
/// the 409 race the drain has to survive (a turn starting between the settle and
/// the POST).
protocol ChatSendTransport {
    func createConversation(agentID: String, title: String?) async throws -> String
    func sendMessage(
        conversationID: String, agentID: String, text: String, images: [ImagePayload]
    ) async throws -> String
    /// Behind the seam for the queue's sake: a STOP is one of the moments that has to
    /// drain (see `stopTurn`), and a stop that cannot succeed cannot be shown to.
    func stopConversation(id: String, agentID: String) async throws -> ConversationStopped
}

extension WalnutAPI: ChatSendTransport {}

/// Chat state — conversation list, active conversation's messages, one live
/// SSE stream, and the send flow (POST → 202 → deltas over SSE).
///
/// Caching: the conversation list and each conversation's message tail are
/// written to DiskCache so relaunches render instantly (stale-while-revalidate).
@Observable
@MainActor
final class ChatStore {
    private let api = WalnutAPI()
    /// Message reads go through the seam, not `api`: in production they are the
    /// same object, and a hosted test can script the ordering (see
    /// `ChatMessagesTransport`).
    @ObservationIgnored private let transport: ChatMessagesTransport
    /// Writes go through their own seam — see `ChatSendTransport`.
    @ObservationIgnored private let sendTransport: ChatSendTransport
    private var sse: SSEClient?
    @ObservationIgnored private var trackedTasks: [UUID: Task<Void, Never>] = [:]
    /// In-flight send()s. Kept separate from `trackedTasks` only because they
    /// return a value; they are cancelled by the same teardown path.
    @ObservationIgnored private var trackedSends: [UUID: Task<SendAttempt, Never>] = [:]
    private var isActive = true
    weak var connection: ConnectionStore?
    /// Bumps once per successful conversation-stream connection (first connect
    /// and every reconnect). Observed by exactly one reader, the composer's model
    /// pill, which re-asks the engine then: a reconnect is when a box that was
    /// unreachable can answer again. Edge-rate (per connection), never event-rate.
    private(set) var streamConnects = 0

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
    /// Did the LAST applied messages fetch prove the watched turn is over? nil
    /// until one lands (and reset before each fetch, so a failed or dropped read
    /// never settles a turn on the previous read's evidence).
    ///
    /// It exists because the watchdog's question has to be asked of the FULL
    /// fetched list, while `messages` deliberately holds only the settled prefix
    /// mid-turn (see `settledRows`), and asking the truncated list would answer
    /// "not over" forever and the composer would stay frozen after a genuinely
    /// lost message-end, which is the freeze this watchdog exists to break.
    private var lastFetchSettledTurn: Bool?

    var conversations: [ConversationSummary] = []
    var activeID: String?
    var messages: [ChatMessage] = []
    var hasOlder = false

    /// Which conversation each LOCAL row in `messages` belongs to, keyed by row
    /// id. The `local-…` optimistic user bubble and the `turn-…` provisional
    /// reply are the only rows this store invents, and they are exactly the rows
    /// `carryLocalRows` keeps across a canonical refetch.
    ///
    /// The owner is what makes that decision answerable. "The fetch has not
    /// caught up with this row yet" (a replica lagging git-sync — keep it) and
    /// "this row belongs to the conversation you just left" (drop it) look
    /// IDENTICAL from the row alone, and guessing wrong the second way is how a
    /// previous conversation's text ends up rendered under the new
    /// conversation's title. Cleared whenever the conversation or the agent
    /// changes; pruned after every merge to the rows still on screen, so it
    /// cannot grow. Internal for WalnutTests.
    @ObservationIgnored private(set) var localRowConversation: [String: String] = [:]

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
    /// True from the instant a conversation is selected until its first page
    /// RESOLVES — landed, empty, or failed.
    ///
    /// WHY IT IS NOT `loadingMessages`: that flag is store-wide and only goes up
    /// once the fetch task actually runs, and it is also raised by the 5s poll and
    /// the turn-end refetch. This one answers exactly one question — "is this
    /// conversation's transcript still unknown?" — which is what the skeleton needs.
    /// Measured cold on a 200-row page: 3.23s of pure white, 1845ms of it the
    /// server's first JSONL parse, with no skeleton and no spinner. A blank screen
    /// for three seconds is read as a broken app, and nothing can paint sooner
    /// because there is genuinely nothing to paint yet.
    private(set) var firstPageInFlight = false
    var sending = false
    /// A turn is running on the active conversation.
    ///
    /// THE DRAIN IS TRIGGERED EXPLICITLY, AND THIS OBSERVER IS ONLY A NET.
    ///
    /// Six places in this file put the flag down and they are not one choke point:
    /// `message-end`, the SSE `error` arm, the stall WATCHDOG reconciling a lost
    /// `message-end`, an explicit stop, a conversation switch, and teardown. A queue
    /// drained from the `message-end` handler alone sits stuck forever on exactly
    /// the turn whose `message-end` never arrived, which is the turn a user is most
    /// likely to have queued behind — so every one of those sites, plus foreground
    /// resume and stream reconnect (neither of which touches this flag at all),
    /// calls `scheduleQueueDrain()` for itself.
    ///
    /// THE CONSTRAINT THIS COMMENT EXISTS FOR: nothing may depend on `didSet` firing
    /// for a SAME-VALUE write. It does fire for one today, and an earlier cut leaned
    /// on that (`select` writing false over false was the only thing that delivered a
    /// queue banked in a conversation the user came back to) — which put it in direct
    /// conflict with `setStreaming`'s equality gate below, so anyone obeying that
    /// comment, or adding `guard streaming != newValue` here, silently stopped
    /// delivering the user's messages. The explicit calls are the contract; this
    /// observer only catches a FUTURE site that forgets one.
    var streaming = false {
        didSet { if !streaming { scheduleQueueDrain() } }
    }
    /// Messages banked while a turn was running, oldest first. Delivered one at a
    /// time as turns settle; persisted so an app kill cannot eat them.
    ///
    /// Written only through `setQueue` (which keeps `queuedRowStates` and the disk
    /// copy in step); internal rather than private so WalnutTests can read it.
    private(set) var queuedSends: [QueuedSend] = []
    /// Where each banked bubble is in its life, for the timeline's badge. A stored
    /// mirror of `queuedSends` rather than a computed map: the timeline reads it on
    /// every update pass, and a queued row must not cost a rebuild per frame.
    private(set) var queuedRowStates: [String: QueuedSend.Status] = [:]
    /// Convenience for the paths that only ask "is this row banked at all".
    var queuedRowIDs: Set<String> { Set(queuedRowStates.keys) }
    /// Single-flight drain. Two settles landing together must not both start
    /// posting the same head of the queue.
    @ObservationIgnored private var queueDrainTask: Task<Void, Never>?
    /// Accumulated live assistant text for the in-flight turn. Bounded like
    /// SessionConversationStore.liveText (LiveMarkdownWindow.boundedTail in
    /// flushPendingDelta) — retaining an unbounded reply makes every append +
    /// segments() O(reply), the 0x8BADF00D saturation mechanism.
    var streamText = ""
    /// True when streamText dropped its head to stay under the retention cap
    /// (drives the live row's "earlier output hidden" chip).
    private(set) var streamTextTruncated = false
    /// Reasoning the agent has emitted during the in-flight turn — published on
    /// the same coalesced cadence as `streamText`, from the shared
    /// `LiveAgentActivity` below. Empty = nothing to show.
    private(set) var liveThinking = ""
    /// Every tool call THIS TURN has made, UNFOLDED — the same pairs `activity`
    /// carries one at a time as a "name · detail" string. The timeline needs the
    /// parts to build real tool rows (see `TimelineInput.liveTools`); the folded
    /// string could only ever be a status line, which is why a tool used mid-turn
    /// left no trace once the turn ended.
    ///
    /// A finished call STAYS in this list until the canonical transcript replaces
    /// it (`clearLiveThinking`). Retiring it on its own `tool-result` is what made
    /// the chip vanish the instant the tool returned — see `LiveToolCall`.
    private(set) var liveTools: [LiveToolCall] = []
    /// The `thinking` / `tool` / `tool-result` arms, shared with
    /// SessionConversationStore. NOT observed: the accumulation is a hot buffer
    /// (the stream repeats `thinking` at whatever rate the agent emits), and only
    /// `flushLiveThinking` publishes it.
    @ObservationIgnored private var live = LiveAgentActivity()
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

    /// Rows per page of `/conversations/:id/messages`.
    ///
    /// `limit` COUNTS ROWS, NOT MESSAGES, and a row is now a prose message OR a
    /// tool row OR a thinking row. Measured over 25 real conversations on the
    /// primary: 897 rows for 222 prose messages, i.e. **4.0 rows per prose
    /// message** on average, 6-8 on a tool-heavy one and 50 on the worst outlier
    /// (100 rows carrying 2 prose messages). So the 50 that shipped here bought
    /// 9-13 prose messages on the long conversations — five or six exchanges,
    /// after which "Load earlier messages" appears. Before history carried
    /// tool/thinking rows, the same 50 bought 50 prose messages, so this is a
    /// regression in felt depth that arrived with the richer payload rather than
    /// a new bug.
    ///
    /// 200 restores it: on the two genuinely long conversations measured it
    /// yields 46 and 41 prose messages (against 13 and 9) for 202KB and 278KB,
    /// and for 23 of the 25 it simply fetches the WHOLE conversation (≤60 rows,
    /// ≤60KB) — the byte cost lands only where the depth is needed. Server time
    /// does not move at all (40-270ms, uncorrelated with the limit): the route
    /// parses the whole JSONL before the slice is applied, so the page size buys
    /// bytes, not work. Still well inside the timeline's own ≤400-message design
    /// ceiling (see TimelineLayoutActor's row cache).
    ///
    /// Re-measure before raising it further: this page is refetched at every turn
    /// end (`loadMessages` from the turn-end path), so it is a per-turn cost on
    /// cellular, not a one-time open cost.
    private static let pageSize = 200
    /// Rows per page of `/conversations`. Spelled here rather than left to the
    /// API's default because the queue's prune has to know whether the answer it is
    /// judging was TRUNCATED (see `ChatSendQueueRules.pruned`).
    private static let conversationListLimit = 50
    private static let cacheTail = 60

    // MARK: - Lifecycle

    /// `transport` / `sendTransport` nil (production) = this store's own
    /// `WalnutAPI` instance. WalnutTests pass scripted ones to drive the real
    /// conversation-switch ordering and the real queue drain without a network.
    init(transport: ChatMessagesTransport? = nil, sendTransport: ChatSendTransport? = nil) {
        self.transport = transport ?? api
        self.sendTransport = sendTransport ?? api
        LifecycleHub.shared.register(self)
    }

    /// Is `conversationID` STILL the conversation on screen?
    ///
    /// Every async result here resolves later than the tap that asked for it,
    /// and the user can open another conversation in between — so a request
    /// captures its conversation when it starts and re-checks it HERE, when the
    /// result lands. Applying a result without this check renders one
    /// conversation's messages under another conversation's title, and since
    /// nothing refetches afterwards the mismatch is stable rather than a flash
    /// (2026-09-07 drawer UI gate).
    private func stillViewing(_ conversationID: String?) -> Bool {
        isActive && conversationID == activeID
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
        // Before anything is selected: a queue restored after the first `select`
        // would have no bubbles until the next switch.
        await restoreQueuedSendsFromDisk()
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
        localRowConversation.removeAll()
        hasOlder = false
        // This path clears `activeID` without going through `select`, so it owns
        // the reset too — otherwise the outgoing conversation's in-flight flag
        // would keep a skeleton up over the new agent's (empty) resting state.
        firstPageInFlight = false
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
            let fetched = try await api.conversations(
                agentID: agentID, limit: Self.conversationListLimit
            )
            guard isActive, !Task.isCancelled else { return }
            connection?.reportReachability(true, source: "chat-rest")
            guard agentID == activeAgentID else { return }
            conversations = fetched
            DiskCache.save(conversations, key: conversationsCacheKey)
            pruneQueue(against: fetched)
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
        clearLiveThinking()
        activity = nil
        errorMessage = nil
        initialPaintDone = false
        messages = []
        // `hasOlder` belongs to the conversation that was on screen, and NOTHING
        // reset it here: opening New chat straight after a long conversation left
        // it true, so a brand-new empty chat offered "Load earlier messages" at the
        // top of nothing (2026-09-12 gate). The first page for the new selection is
        // what re-establishes it.
        hasOlder = false
        // A conversation being opened is on the hook for its first page from THIS
        // instant, not from whenever the fetch task gets scheduled — the gap is what
        // let the "Your Personal AI is listening" empty state flash during a switch,
        // and it is where the skeleton has to start.
        firstPageInFlight = id != nil
        // Nothing the previous conversation invented may outlive it: the owner
        // map is what tells a later merge that a leftover echo is not ours, and
        // an entry whose row is gone would be a lie about the next conversation.
        localRowConversation.removeAll()
        // Banked sends outlive a conversation switch (they are the user's words,
        // not a view state), so the rows that picture them are rebuilt here — the
        // wipe above removed the bubbles, never the queue.
        restoreQueuedBubbles(for: id)
        connectStream()
        // Explicit, not via the flag above: the conversation being opened may have
        // messages banked from a previous visit and there is no turn here to end.
        scheduleQueueDrain()
        if let id {
            // Cached tail hydrates OFF-MAIN (P0-1) and only wins while nothing
            // canonical has landed for this conversation yet — loadMessages runs
            // concurrently and its result is authoritative whichever finishes
            // first. `stillViewing` is the apply-time check: this read can land
            // several conversation switches later.
            trackTask { [weak self] in
                guard let self else { return }
                if let cached = await DiskCache.loadAsync([ChatMessage].self, key: "messages-\(id)"),
                   !cached.isEmpty, self.stillViewing(id),
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
        // Refuse a load for a conversation nobody is looking at, BEFORE flipping
        // `loadingMessages`: that flag is store-wide, so a stale conversation's
        // fetch would redact the timeline of the conversation the user did open.
        guard stillViewing(id) else { return }
        loadingMessages = true
        // Resolved either way — landed, empty, or thrown. A skeleton that outlives
        // a FAILED first page is a permanent fake-loading screen, which is the one
        // way a placeholder is worse than the blank it replaced. Deliberately after
        // the `stillViewing` guard: a load for a conversation nobody is looking at
        // must not clear the flag the VISIBLE conversation's own load raised.
        defer {
            loadingMessages = false
            firstPageInFlight = false
        }
        // Cleared BEFORE the read: a verdict is only ever this read's own.
        lastFetchSettledTurn = nil
        do {
            let agentID = activeAgentID
            let fetched = try await transport.messages(
                conversationID: id, agentID: agentID, limit: Self.pageSize, before: nil
            )
            guard isActive, !Task.isCancelled else { return }
            connection?.reportReachability(true, source: "chat-rest", endpoint: "/api/v1/conversations/messages")
            // Apply-time check, not request-time: this answer describes `id`, and
            // `id` is only allowed to write `messages` while it is still the
            // conversation on screen. A fetch that raced a drawer tap is DROPPED
            // — the conversation the user actually opened has its own fetch, and
            // that one is the authority for what is rendered under its title.
            guard stillViewing(id), agentID == activeAgentID else { return }
            // A read that landed retracts the previous read's banner (and only that
            // one), so pull-to-refresh visibly resolves instead of leaving a stale
            // complaint above a transcript that is now correct.
            retractMessagesLoadFailure()
            // Carry local-only bubbles across the replace — server history
            // doesn't know about them and a refetch must never erase them.
            // Besides failed/in-flight optimistic bubbles, this keeps
            // SOLIDIFIED local echoes (the `local-…` user bubble after its 202,
            // and finalizeTurn's `turn-…` provisional reply) that the fetch
            // doesn't contain yet: a cloud replica's GET /messages serves a
            // LAGGING copy until git-sync converges, and adopting that copy
            // wholesale erased the user's just-sent message AND the fresh
            // reply right after the turn ended (2026-08-23 dogfood round 10).
            let localOnly = Self.carryLocalRows(
                current: messages, fetched: fetched,
                conversationID: id, owners: localRowConversation
            )
            // The verdict is the FULL list's answer, banked for the watchdog
            // before anything is dropped (see `lastFetchSettledTurn`).
            let settled = Self.turnSettled(history: fetched, watched: watchedUserText)
            lastFetchSettledTurn = settled
            // Mid-turn, the rows of the turn in flight stay OUT of the timeline:
            // the live region owns that turn and renders it with what the stream
            // knows (see `settledRows`). Once the turn is over (message-end has
            // already cleared `streaming`, or this very fetch proves it), the full
            // list is installed exactly as before.
            let installed = (streaming && !settled)
                ? Self.settledRows(fetched, watched: watchedUserText)
                : fetched
            let wasAtBottom = bottomPinned
            let changed = installed.count + localOnly.count != messages.count
                || installed.last?.id != messages.dropLast(localOnly.count).last?.id
            MainWork.track("chat.loadMessages", count: installed.count) {
                messages = Self.reattachSentImages(to: installed, from: sentImages) + localOnly
                // HANDOFF: the live reasoning region retires HERE, in the same
                // synchronous block that installs the fetched `kind:"thinking"`
                // rows — so the same reasoning is never rendered twice, and a
                // refetch that fails or arrives late leaves the reasoning on
                // screen instead of blanking the spot it occupied. Gated on
                // `streaming` because this also runs from the 5s poll / watchdog
                // paths, and a mid-turn load must not wipe reasoning that is
                // still accumulating.
                if !streaming { clearLiveThinking() }
            }
            // The owner map describes rows that are ON SCREEN and nothing else:
            // an echo the fetch just absorbed has no owner left to record.
            let survivingLocalIDs = Set(localOnly.map(\.id))
            localRowConversation = localRowConversation.filter { survivingLocalIDs.contains($0.key) }
            // Freeze-report context: rows handed to SwiftUI for layout.
            FreezeContext.shared.setHistoryRows(messages.count)
            // The PAGE decides whether there is more history, so this stays the
            // full fetch: a truncated mid-turn install would claim there is no
            // earlier page on a conversation shorter than one page plus a turn.
            hasOlder = fetched.count >= Self.pageSize
            // Replacing rows with canonical ids/heights displaces the viewport
            // once the bottom anchor's auto-pin has lapsed (any manual scroll)
            // — glue the reader back only if they were already at the bottom.
            // The FIRST load always pins: see initialPaintDone (blank-list fix).
            if isActive && (!initialPaintDone || (changed && wasAtBottom)) { scrollToBottomSignal += 1 }
            initialPaintDone = true
            // Cache what was INSTALLED. The cache is a picture of the timeline for
            // the next launch, and there is no live region then to correct an
            // in-flight tool row rendered as a finished one.
            DiskCache.save(Array(installed.suffix(Self.cacheTail)), key: "messages-\(id)")
        } catch {
            reportIfNetwork(error)
            noteMessagesLoadFailure(error, conversationID: id)
        }
    }

    /// A MESSAGES FETCH THAT DID NOT LAND HAS TO BE SEEN.
    ///
    /// `reportIfNetwork` only reacts to `APIError.network`, so every other failure left
    /// the transcript showing "Your Personal AI is listening" — no banner, no retry,
    /// nothing in the log. That is the honest empty state for an empty conversation and
    /// a lie for a failed read, and it is how a server emitting one lone surrogate
    /// escape (which `JSONDecoder` rejects for the whole document) blanked a
    /// conversation with 24 messages in it (2026-09-12 gate).
    ///
    /// Two failures stay mute on purpose: a CANCELLATION is the app's own doing (a
    /// conversation switch tears the previous fetch down), and a TRANSPORT failure is
    /// already the offline banner's sentence — saying it twice, in two different
    /// registers, is worse than saying it once.
    private func noteMessagesLoadFailure(_ error: Error, conversationID: String) {
        guard isActive, !Task.isCancelled, stillViewing(conversationID) else { return }
        if error is CancellationError { return }
        if let apiError = error as? APIError {
            if apiError.isCancelled { return }
            if case .network = apiError { return }
        }
        AppLog.error("chat", "messages load failed", [
            "conversation": conversationID,
            "agent": activeAgentID,
            "error": String(describing: error),
            "detail": Self.messagesLoadFailureBanner(error),
        ])
        errorMessage = Self.messagesLoadFailureBanner(error)
    }

    /// ONE sentence for a failed read, and it names the retry the transcript really
    /// offers: pull-to-refresh re-runs `loadMessages` (see `MessageListView.onRefresh`).
    /// The cause is carried through verbatim from `APIError` rather than replaced with a
    /// generic apology — "Unexpected server response" is what tells a reporter that the
    /// body was undecodable rather than the server refusing them.
    nonisolated static func messagesLoadFailureBanner(_ error: Error) -> String {
        let cause = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        return "\(messagesLoadFailurePrefix) \(cause). Pull down to try again."
    }

    /// How a load-failure banner is RECOGNISED later, so a load that finally succeeds can
    /// retract its own sentence and nothing else. A send error ("Still replying…") and a
    /// turn error belong to the reader's last action and must survive a background poll.
    nonisolated static let messagesLoadFailurePrefix = "Couldn't load this conversation:"

    /// Take down a load-failure banner once a load has actually landed.
    private func retractMessagesLoadFailure() {
        if errorMessage?.hasPrefix(Self.messagesLoadFailurePrefix) == true { errorMessage = nil }
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
    ///
    /// `conversationID` is the conversation the FETCH is for, and `owners` says
    /// which conversation each local row belongs to (`localRowConversation`).
    /// Every rule below asks a question about this conversation's fetch ("has the
    /// canonical copy landed yet"), which is unanswerable for a row that came
    /// from a DIFFERENT conversation — such a row is not lagging, it is simply
    /// somebody else's, and carrying it forward is what renders the previous
    /// conversation's text under the new conversation's title. A row with no
    /// recorded owner counts as this conversation's: the store tags every local
    /// row it invents and drops the whole map on a switch, so untagged means
    /// canonical (or a caller with no conversation scope, e.g. a pure-logic test).
    nonisolated static func carryLocalRows(
        current: [ChatMessage], fetched: [ChatMessage],
        conversationID: String? = nil,
        owners: [String: String] = [:],
        now: Date = Date()
    ) -> [ChatMessage] {
        func key(_ m: ChatMessage) -> String { "\(m.role)|\(m.text)" }
        let isEcho: (ChatMessage) -> Bool = {
            $0.id.hasPrefix("local-") || $0.id.hasPrefix("turn-")
                || $0.id.hasPrefix("queued-")
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
            // Another conversation's row is dropped FIRST, ahead of every other
            // rule: not kept for being pending, not kept for being failed, not
            // kept for being inside the TTL. Those rules all mean "this
            // conversation's fetch has not caught up yet", which cannot be true
            // of a row that was never part of this conversation.
            if let owner = owners[row.id], let conversationID, owner != conversationID {
                continue
            }
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
            let older = try await transport.messages(
                conversationID: id, agentID: activeAgentID,
                limit: Self.pageSize, before: oldest.id
            )
            guard !Task.isCancelled, stillViewing(id) else { return }
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
    ///
    /// NOTE it is no longer the whole answer to "will my words survive this
    /// send": a turn in flight now BANKS them (`SendOutcome.queued`) instead of
    /// refusing, so the only refusal that keeps nothing is a store that cannot
    /// take words at all. Ask `sendReportingOutcome` for that distinction.
    var acceptsNewTurn: Bool { isActive && !sending && !streaming }

    /// What happened to the WORDS — which is not the same question as whether a
    /// turn started, and conflating the two is how a dictated sentence ends up
    /// either deleted or sent twice.
    enum SendOutcome: Equatable {
        /// A turn was attempted for them. `accepted` is the server's answer; false
        /// still means the words are SAFE, as a retryable failed bubble.
        case started(accepted: Bool)
        /// Banked behind the running turn, with a bubble on screen. Delivered at
        /// the next settle.
        case queued
        /// Nothing anywhere is holding them: the store is torn down, there is no
        /// conversation to bank them against, or the queue is at its ceiling.
        case refusedKeepingNothing

        /// Did anything at all keep these words? The question a caller holding the
        /// only copy has to ask (see `ComposerBar.voiceRescueReason`).
        var keptTheWords: Bool { self != .refusedKeepingNothing }
    }

    @discardableResult
    func send(_ text: String, images: [SelectedImage] = []) async -> Bool {
        // Preserved exactly: "did the server take this turn", which is what every
        // existing caller of this Bool asks.
        if case .started(let accepted) = await sendReportingOutcome(text, images: images) {
            return accepted
        }
        return false
    }

    func sendReportingOutcome(_ text: String, images: [SelectedImage] = []) async -> SendOutcome {
        // Agent blocked on a structured question: route the composer text to
        // the answer endpoint (mirrors the web chat's interception — posting
        // a new message would 409 turn_active and deadlock the flow).
        if pendingQuestion, !text.isEmpty {
            return .started(accepted: await answerQuestion(text))
        }
        // A turn is in flight and the store is otherwise healthy: bank the words.
        // The composer's primary button is a SEND again in this state, so refusing
        // here would be offering a seat that leads nowhere.
        // A turn is in flight, or something is already waiting here. Both bank: the
        // second is the ORDERING INVARIANT (`hasQueuedSendsHere`), without which a
        // send made between one turn settling and the next starting overtakes
        // messages the user typed earlier.
        if isActive, sending || streaming || hasQueuedSendsHere {
            return enqueue(text, images: images) ? .queued : .refusedKeepingNothing
        }
        guard acceptsNewTurn else { return .refusedKeepingNothing }
        let id = UUID()
        let task = Task { @MainActor [weak self] in
            guard let self else { return SendAttempt.failed(provenNeverArrived: true, refused: false) }
            return await self.performSend(text, images: images)
        }
        trackedSends[id] = task
        let attempt = await task.value
        trackedSends[id] = nil
        return .started(accepted: attempt == .accepted)
    }

    /// Mark the optimistic bubble as a failed one (tap to retry) — the text and
    /// its images must never disappear, whatever went wrong.
    private func markSendFailed(_ messageID: String) {
        guard let idx = messages.firstIndex(where: { $0.id == messageID }) else { return }
        messages[idx].pending = false
        messages[idx].failed = true
    }

    /// How far a single POST got. Three answers rather than a Bool because the
    /// drain has to treat a 409 differently from every other failure: a turn that
    /// started in the gap between the settle and the POST is not the message's
    /// fault, so the entry goes BACK to the front of the queue instead of becoming
    /// a failed bubble.
    enum SendAttempt: Equatable {
        case accepted
        /// The POST did not land. The two flags are everything the drain needs to
        /// know about the error, classified here where the error still exists (an
        /// `Error` is not `Sendable`, so it cannot ride the result):
        /// `provenNeverArrived` decides whether the entry may be re-banked, and
        /// `refused` says the server read THIS message and declined it, so the
        /// failure is the message's own and the entries behind it are unaffected.
        case failed(provenNeverArrived: Bool, refused: Bool)
        case turnActive
    }

    /// This send is a DRAINED queue entry. Its bubble already exists (so nothing
    /// is appended, and the row the user has been looking at since they typed is
    /// the one that solidifies), and a 409 leaves it alone for the caller to
    /// re-bank.
    private struct DrainContext {
        let rowID: String
    }

    private func performSend(
        _ text: String, images: [SelectedImage], drain: DrainContext? = nil
    ) async -> SendAttempt {
        sending = true
        errorMessage = nil

        let jpegDatas = images.map(\.jpegData)
        var convID = activeID
        // THE AGENT IS CAPTURED HERE, beside the conversation, and for the same
        // reason: everything below runs after at least one suspension point, and the
        // user can switch console agent in that gap. Reading `activeAgentID` at POST
        // time sent conversation A's message under agent B, which is a message
        // delivered to a persona that never saw the thread.
        let agentID = activeAgentID
        // The conversation this send belongs to, captured BEFORE the first
        // suspension point (nil = the lazy new chat, whose id only exists once
        // createConversation answers). A POST easily outlives a drawer tap, so
        // every write below re-checks it: this send's echo, streaming flag and
        // watchdog all describe ONE conversation, and writing them into whatever
        // happens to be on screen afterwards is the same class of bug as
        // adopting a stale fetch.
        let target = convID
        var optimistic = ChatMessage(
            id: drain?.rowID ?? "local-\(Date().timeIntervalSince1970)",
            role: "user", text: text, createdAt: ISO8601DateFormatter().string(from: .now), kind: nil
        )
        optimistic.pending = true
        // Carry thumbnails so the bubble shows them immediately and a failed
        // send retains them for retry (the store owns no-loss preservation).
        if !jpegDatas.isEmpty { optimistic.localImages = jpegDatas }

        if drain == nil {
            // Append FIRST — even payload preparation or createConversation failure
            // must leave the text + images on screen as a failed bubble, never lose them.
            messages.append(optimistic)
            // Tag the echo with its conversation (a new chat has none yet — tagged
            // below, once createConversation names it).
            if let target { localRowConversation[optimistic.id] = target }
        }
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
            // Nothing has left the device at these three exits, so a drained entry
            // may safely be re-banked from them.
            guard isActive, !Task.isCancelled else {
                sending = false
                markSendFailed(optimistic.id)
                return .failed(provenNeverArrived: true, refused: false)
            }
            if convID == nil {
                let created = try await sendTransport.createConversation(
                    agentID: agentID, title: nil
                )
                guard isActive, !Task.isCancelled else {
                    sending = false
                    markSendFailed(optimistic.id)
                    return .failed(provenNeverArrived: true, refused: false)
                }
                convID = created
                // Adopt the new conversation as the active one ONLY while the
                // user is still on the new chat this send started from. If they
                // opened another conversation while POST /conversations was in
                // flight, hijacking their view IS the bug — the message still
                // goes out below (nothing is lost) and the new conversation
                // appears in the drawer on the next list refresh.
                if stillViewing(target) {
                    activeID = created
                    UserDefaults.standard.set(created, forKey: activeConversationKey)
                    localRowConversation[optimistic.id] = created
                    connectStream()
                }
            }
            guard let convID else {
                sending = false
                markSendFailed(optimistic.id)
                return .failed(provenNeverArrived: true, refused: false)
            }
            _ = try await sendTransport.sendMessage(
                conversationID: convID, agentID: agentID, text: text, images: payloads
            )
            // Accepted by the server. If the store went inactive meanwhile the
            // turn is genuinely running — do NOT mark it failed (that would
            // duplicate the message on retry); just skip the local UI state,
            // which resumeStream() rebuilds from canonical history.
            guard isActive, !Task.isCancelled else {
                sending = false
                return .accepted
            }
            connection?.reportReachability(true, source: "chat-rest")
            rememberSentImages(text: text, datas: jpegDatas)
            sending = false
            // Accepted — but the user may be reading another conversation by now.
            // The turn is genuinely running over THERE, so none of the state
            // below describes what is on screen: setting `streaming` would freeze
            // the new conversation's composer with no message-end coming to
            // release it, and the watchdog would be armed against a conversation
            // nobody is watching. Report success and write nothing.
            guard stillViewing(convID) else { return .accepted }
            // Solidify the bubble; message-start arrives on SSE shortly.
            if let idx = messages.firstIndex(where: { $0.id == optimistic.id }) {
                messages[idx].pending = false
            }
            streaming = true
            streamText = ""
            streamTextTruncated = false
            activity = nil
            watchedUserText = text
            startTurnWatchdog(conversationID: convID)
            return .accepted
        } catch {
            sending = false
            // Is the failure still about the conversation on screen? If the user
            // switched away, the bubble this describes left with its conversation
            // (select clears `messages`), so an error banner and a frozen
            // composer would land on a conversation that never sent anything.
            // `markSendFailed` stays unconditional either way: it is an id lookup,
            // so it is exactly a no-op once the row is gone.
            let mine = stillViewing(convID ?? target)
            // Cancelled/suspended sends settle silently but must NOT leave a
            // forever-pending bubble: the draft is already cleared, so the
            // failed bubble (tap to retry) is the only copy of the text.
            // A cancelled or suspended send is INCONCLUSIVE: the request was on its
            // way out and nothing came back to say whether it arrived.
            if !isActive || (error as? APIError)?.isCancelled == true {
                markSendFailed(optimistic.id)
                return .failed(provenNeverArrived: false, refused: false)
            }
            if let apiError = error as? APIError, apiError.isTurnActive {
                // Another turn is running. A DRAINED entry keeps its bubble pending
                // and goes back to the front of the queue (the caller re-banks it),
                // because it already carries a promise of delivery and a turn that
                // started in the gap is not a reason to break it. An ordinary send
                // has made no such promise, so it keeps today's behaviour: the text
                // survives as a failed bubble to retry after message-end.
                if drain == nil { markSendFailed(optimistic.id) }
                guard mine else { return .turnActive }
                streaming = true
                watchedUserText = nil
                if let convID { startTurnWatchdog(conversationID: convID) }
                if drain == nil {
                    errorMessage = "The assistant is already replying. Tap the message to retry when it finishes."
                }
                return .turnActive
            }
            // KEEP the bubble, marked failed — the user's text must never
            // vanish on a network error. Tap to retry / copy / delete.
            markSendFailed(optimistic.id)
            reportIfNetwork(error)
            let neverArrived = ChatSendQueueRules.earnsAutomaticRetry(error)
            let refused = ChatSendQueueRules.isConclusiveRefusal(error)
            guard mine else { return .failed(provenNeverArrived: neverArrived, refused: refused) }
            errorMessage = error.localizedDescription
            return .failed(provenNeverArrived: neverArrived, refused: refused)
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
        localRowConversation[message.id] = nil
        // The user has taken charge of this row. If it was still a queue entry (an
        // `undecided` one, restored from a POST that died in flight), it must leave
        // the disk with the bubble, or it reappears on the next conversation switch.
        dropQueueEntry(message.id)
        errorMessage = nil
        await send(message.text, images: images)
    }

    func discardFailed(_ message: ChatMessage) {
        messages.removeAll { $0.id == message.id }
        localRowConversation[message.id] = nil
        dropQueueEntry(message.id)
    }

    // MARK: - Send queue (mid-turn sends)

    /// The composer's ceiling row, or nil. Derived rather than latched, so it
    /// appears while a ceiling is reached (before a tap is refused) and clears
    /// itself the moment a message goes out.
    var queueFullNotice: String? {
        ChatSendQueueRules.ceilingNotice(
            queuedSends, conversationID: activeID, agentID: activeAgentID
        )
    }

    /// Is anything already waiting for the conversation on screen?
    ///
    /// The ORDERING INVARIANT, and the reason it is a property rather than a
    /// detail of the send path: while a queue exists for this conversation, a new
    /// send must join the BACK of it rather than post immediately, or a send made
    /// in the window between one turn settling and the next starting jumps the line
    /// and the agent reads the user's instructions out of order. The web console
    /// gets this for free by holding `isStreaming` true until its queue empties;
    /// asking the queue directly is the same invariant without a flag that lies.
    var hasQueuedSendsHere: Bool {
        queuedSends.contains {
            $0.status != .undecided && $0.conversationID == activeID
                && $0.agentID == activeAgentID
        }
    }

    /// Bank a message behind the running turn. Returns false only when nothing
    /// kept it, which is the answer a caller holding the only copy of the text
    /// acts on (see `SendOutcome.keptTheWords`).
    private func enqueue(_ text: String, images: [SelectedImage]) -> Bool {
        let jpegDatas = images.map(\.jpegData)
        guard ChatSendQueueRules.hasContent(text: text, images: jpegDatas) else { return false }
        let bytes = jpegDatas.reduce(0) { $0 + $1.count }
        if let refusal = ChatSendQueueRules.refusal(
            toEnqueueInto: queuedSends, conversationID: activeID,
            agentID: activeAgentID, newBytes: bytes
        ) {
            AppLog.info("chat", "send refused rather than banked", [
                "reason": String(describing: refusal),
                "conversationID": activeID ?? "-", "queued": "\(queuedSends.count)",
            ])
            return false
        }
        guard let conversationID = activeID else { return false }
        let rowID = "queued-\(UUID().uuidString)"
        let createdAt = ISO8601DateFormatter().string(from: .now)
        let entry = QueuedSend(
            id: rowID, conversationID: conversationID, agentID: activeAgentID,
            text: text, images: jpegDatas, createdAt: createdAt
        )
        // DISK FIRST. The composer clears its draft on the strength of this answer,
        // so "banked" has to mean the words are somewhere that survives a kill. A
        // write that did not land is a refusal, and the composer puts the text back.
        guard setQueue(queuedSends + [entry]) else {
            AppLog.error("chat", "refused a send because it could not be persisted", [
                "conversationID": conversationID,
            ])
            return false
        }
        messages.append(bubble(for: entry))
        localRowConversation[rowID] = conversationID
        bottomPinned = true
        if isActive { scrollToBottomSignal += 1 }
        return true
    }

    /// The optimistic bubble for a banked message: the SAME shape `performSend`
    /// appends, so nothing downstream has to know the difference. It keeps the id
    /// it was created with all the way through delivery, so a message can never be
    /// on screen twice.
    ///
    /// `localImages` here is NOT a second copy of the photo. `Data` is
    /// copy-on-write, so this array and the queue entry's reference the same bytes.
    private func bubble(for entry: QueuedSend) -> ChatMessage {
        var bubble = ChatMessage(
            id: entry.id, role: "user", text: entry.text,
            createdAt: entry.createdAt, kind: nil
        )
        // An `undecided` entry is one whose POST was in flight when the process
        // died: it renders as the retryable failed bubble, never as a promise.
        if entry.status == .undecided {
            bubble.failed = true
        } else {
            bubble.pending = true
        }
        if !entry.images.isEmpty { bubble.localImages = entry.images }
        return bubble
    }

    /// The ONE writer. Keeps the status mirror and the disk copy in step, and
    /// reports whether the DISK copy landed — the callers that are about to stop
    /// holding the words elsewhere check it.
    @discardableResult
    private func setQueue(_ queue: [QueuedSend]) -> Bool {
        let landed = ChatSendQueueStore.persist(queue, previous: queuedSends)
        queuedSends = queue
        queuedRowStates = Dictionary(uniqueKeysWithValues: queue.map { ($0.id, $0.status) })
        return landed
    }

    /// Take a banked message back.
    ///
    /// Only a `pending` entry: once a POST is out the server may already have the
    /// message, so there is nothing here that could take it back. The control is
    /// removed from the row at the same moment (`queuedRowStates` drives the badge),
    /// because a Withdraw button that silently does nothing is worse than no button.
    func withdrawQueued(_ rowID: String) {
        guard queuedRowStates[rowID] == .pending else { return }
        setQueue(queuedSends.filter { $0.id != rowID })
        messages.removeAll { $0.id == rowID }
        localRowConversation[rowID] = nil
    }

    /// Forget a queue entry whose bubble the user has taken charge of (a retry, a
    /// discard). Without this an `undecided` row would come back on the next
    /// conversation switch, after the user had already dealt with it.
    private func dropQueueEntry(_ rowID: String) {
        guard queuedRowStates[rowID] != nil else { return }
        setQueue(queuedSends.filter { $0.id != rowID })
    }

    /// Re-materialise the bubbles for a conversation's banked messages.
    ///
    /// `select` empties `messages`, and a restored queue has no bubbles at all, so
    /// the rows are DERIVED from the queue rather than being the thing that
    /// survives. The queue is the record; the bubble is a picture of it.
    private func restoreQueuedBubbles(for conversationID: String?) {
        guard let conversationID else { return }
        for entry in queuedSends where entry.conversationID == conversationID
            && entry.agentID == activeAgentID {
            // Idempotent: the launch path and a conversation switch can both ask,
            // and a second bubble for one entry would be the same words twice.
            guard !messages.contains(where: { $0.id == entry.id }) else { continue }
            messages.append(bubble(for: entry))
            localRowConversation[entry.id] = entry.conversationID
        }
    }

    /// Adopt a queue persisted by an earlier run. Separate from the disk read so a
    /// test can hand over a queue without depending on cache timing.
    func adoptQueuedSends(_ restored: [QueuedSend]) {
        guard !restored.isEmpty || !queuedSends.isEmpty else { return }
        setQueue(ChatSendQueueRules.restored(restored))
        restoreQueuedBubbles(for: activeID)
    }

    private func restoreQueuedSendsFromDisk() async {
        guard queuedSends.isEmpty else { return }
        let restored = await ChatSendQueueStore.restore()
        guard !restored.isEmpty, isActive else { return }
        AppLog.info("chat", "restored banked sends", [
            "count": "\(restored.count)",
            "undecided": "\(restored.filter { $0.status == .processing }.count)",
        ])
        adoptQueuedSends(restored)
    }

    /// Drop banked messages whose conversation the server no longer lists.
    ///
    /// Only ever called with a list that LANDED (see `refreshConversations`): an
    /// empty set from a failed read means "we could not ask", and acting on it
    /// would delete the user's words on an offline launch. Internal rather than
    /// private so WalnutTests drive the real prune instead of a copy of it.
    func pruneQueue(against fetched: [ConversationSummary]) {
        guard !queuedSends.isEmpty else { return }
        let pruned = ChatSendQueueRules.pruned(
            queuedSends, listedConversations: Set(fetched.map(\.id)),
            agentID: activeAgentID,
            listWasTruncated: fetched.count >= Self.conversationListLimit
        )
        guard pruned.count != queuedSends.count else { return }
        let dropped = Set(queuedSends.map(\.id)).subtracting(pruned.map(\.id))
        AppLog.info("chat", "dropped banked sends for conversations that are gone", [
            "count": "\(dropped.count)",
        ])
        setQueue(pruned)
        messages.removeAll { dropped.contains($0.id) }
        for id in dropped { localRowConversation[id] = nil }
    }

    /// Start a drain if this is a moment one belongs in.
    ///
    /// Called explicitly from every path that can END a turn or RESTORE the app's
    /// ability to talk to the server; the `didSet` on `streaming` is only a net for
    /// a future site that forgets (see that property's comment).
    ///
    /// Each guard is a state some caller really is in: teardown (`closeStream`
    /// clears `isActive` first, which is what makes it distinguishable), a POST
    /// still in flight, a turn still running, a conversation with nothing banked,
    /// and OFFLINE — draining with no network turns ten banked messages into ten
    /// red bubbles in a tight loop, which is the queue destroying exactly what it
    /// exists to protect.
    private func scheduleQueueDrain() {
        guard isActive, !sending, !streaming, !queuedSends.isEmpty else { return }
        guard connection?.online != false else { return }
        guard ChatSendQueueRules.nextDeliverable(
            queuedSends, conversationID: activeID, agentID: activeAgentID
        ) != nil else { return }
        guard queueDrainTask == nil else { return }
        queueDrainTask = Task { @MainActor [weak self] in
            await self?.drainQueue()
            self?.queueDrainTask = nil
        }
    }

    /// Deliver banked messages, one at a time, each as an ordinary new turn. The
    /// server contract is untouched: nothing here batches, merges, or interleaves.
    ///
    /// STOPS ON THE FIRST FAILURE. Marching on turned one network blip into a wall
    /// of red bubbles; the entries left behind keep their promise instead, and the
    /// next settle, reconnect or foreground tries again.
    private func drainQueue() async {
        while true {
            guard isActive, !sending, !streaming, !Task.isCancelled else { return }
            guard connection?.online != false else { return }
            guard let index = ChatSendQueueRules.nextDeliverable(
                queuedSends, conversationID: activeID, agentID: activeAgentID
            ) else { return }
            let entry = queuedSends[index]
            // `processing`, ON DISK, before the POST goes out. Removing it here (the
            // first cut did) opens a window where a kill leaves the words in no
            // queue, no cache and possibly no server: the pending bubble is never
            // persisted, because the message cache only holds server rows.
            var marked = queuedSends
            marked[index] = entry.with(status: .processing)
            setQueue(marked)
            let images = entry.images.compactMap { SelectedImage(jpegData: $0) }
            let attempt = await performSend(
                entry.text, images: images, drain: DrainContext(rowID: entry.id)
            )
            switch attempt {
            case .accepted:
                // Known landed: only now may it leave the disk.
                dropQueueEntry(entry.id)
                continue
            case .turnActive:
                // A turn started between the settle and the POST. That answer PROVES
                // the message was refused, so it goes back to the front of the queue
                // rather than becoming a failure the user has to notice.
                requeueAtFront(entry)
                return
            case .failed(let provenNeverArrived, let refused):
                let reBanked = settleFailedDrain(entry, provenNeverArrived: provenNeverArrived)
                // Stop on a failure that says something about the NETWORK or the
                // server (re-banked, or an inconclusive outcome): the next entry would
                // meet the same fate, and ten of those is a wall of red. A refusal is
                // about this one message, and the entry behind it is a different
                // message, so that one still gets its turn.
                if reBanked || !refused { return }
                continue
            }
        }
    }

    /// A drained POST failed. Decide between the two honest outcomes, and report
    /// which: true when the entry went back to the queue.
    ///
    /// The rule is `ChatSendQueueRules.earnsAutomaticRetry`: this endpoint takes no
    /// client-minted message id, so an automatic re-send of a request that MIGHT
    /// have arrived can hand the agent the same instruction twice, and a re-send of
    /// one the server already REFUSED just earns the same refusal while blocking
    /// the queue behind it. Only a failure that proves nothing arrived AND that a
    /// later identical attempt can clear buys another automatic attempt; anything
    /// else becomes the retryable failed bubble a human decides about.
    @discardableResult
    private func settleFailedDrain(_ entry: QueuedSend, provenNeverArrived: Bool) -> Bool {
        // THE BUBBLE, NOT THE CONVERSATION, is the question. `markSendFailed` is an
        // id lookup, so it is a silent no-op once the row is gone — and the row can
        // be gone while the conversation is back on screen (switch to B, switch back
        // to A: `restoreQueuedBubbles` cannot rebuild a row whose entry has left the
        // queue). Asking whether the row is actually there is the only judge that
        // does not lose the words to a proxy.
        let bubbleSurvived = messages.contains { $0.id == entry.id }
        if provenNeverArrived || !bubbleSurvived {
            AppLog.info("chat", "re-banked a drained send", [
                "reason": provenNeverArrived ? "never-arrived" : "bubble-gone",
                "conversationID": entry.conversationID,
            ])
            requeueAtFront(entry)
            return true
        }
        // Inconclusive or refused, and the row is on screen: leave it as the failed
        // bubble `performSend` already made, and take the entry off the disk so
        // nothing automatic can send it a second time.
        dropQueueEntry(entry.id)
        return false
    }

    private func requeueAtFront(_ entry: QueuedSend) {
        let others = queuedSends.filter { $0.id != entry.id }
        setQueue([entry.with(status: .pending)] + others)
        // The row may have been rebuilt or removed while the POST was out; either
        // way it must read as banked again, not as failed.
        if let idx = messages.firstIndex(where: { $0.id == entry.id }) {
            messages[idx].failed = false
            messages[idx].pending = true
        } else if entry.conversationID == activeID, entry.agentID == activeAgentID {
            messages.append(bubble(for: entry.with(status: .pending)))
            localRowConversation[entry.id] = entry.conversationID
        }
    }

    /// Test seam: await whatever drain the last trigger started. Production code
    /// never needs this — the drain is fire-and-forget.
    func awaitQueueDrainForTesting() async {
        await queueDrainTask?.value
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
                    if ok { self?.streamConnects &+= 1 }
                }
            }
        )
        sse?.start()
        // A reconnect is the other moment the app can talk again after not being
        // able to (offline, a dropped stream), and the drain refuses to run offline.
        scheduleQueueDrain()
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
        clearLiveThinking()
        activity = nil
    }

    private func resumeStream() {
        guard !isActive else { return }
        isActive = true
        connectStream()
        if let id = activeID {
            trackTask { [weak self] in await self?.loadMessages(id) }
        }
        // Nothing here assigns `streaming`, so a message banked mid-turn and left
        // while the turn ended off-screen has no flag transition to ride: the badge
        // kept promising "delivers when the current reply finishes" with no reply to
        // finish. `connectStream()` above is what delivers it (it drains on every
        // reconnect, this one included); the refetch then settles `streaming` from
        // canonical history as the second trigger.
    }

    private struct DeltaPayload: Codable { let delta: String }
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

    /// Mirror the shared handler's tool list onto the observed field.
    /// Equality-gated for exactly the reason `setActivity` is: this runs per SSE
    /// event and @Observable has no same-value suppression.
    private func setLiveTools(_ tools: [LiveToolCall]) {
        if liveTools != tools { liveTools = tools }
    }

    /// Test seam: WalnutTests drives the REAL handler (it is private because
    /// its guard needs activeID; tests set that up first). Production code
    /// must keep calling `handle` via the SSE callback only.
    func handleForTesting(_ event: SSEEvent, conversationID: String) {
        handle(event, conversationID: conversationID)
    }

    /// Test seam: the state a real send leaves behind for the watchdog. Private
    /// in production because only the send path may claim a turn; a test staging
    /// a mid-turn refetch needs the same starting point.
    func setWatchedUserTextForTesting(_ text: String?) {
        watchedUserText = text
    }

    private func handle(_ event: SSEEvent, conversationID: String) {
        // Same apply-time rule as every fetch: an event is dispatched onto the
        // MainActor from the SSE callback, so a switch can land in between.
        guard stillViewing(conversationID) else { return }
        lastSSEEventAt = Date()
        let data = Data(event.data.utf8)
        // The three arms both live streams share. `impliesStreaming` is
        // deliberately IGNORED here: the Personal AI chat has never taken a
        // tool/thinking event as proof a turn of its own is running (only
        // message-start and queued do that), and adopting the session store's
        // policy would freeze this composer on somebody else's turn.
        if let handled = LiveStreamEvents.apply(event: event.event, data: data, to: &live) {
            setActivity(live.activityLabel)
            setLiveTools(live.tools)
            if handled.needsFlush { scheduleLiveFlush() }
            // The agent is now blocked on a structured question — surface the
            // answer card. (The stream carries only the tool name; the question
            // text/options are not on the v1 wire.)
            if handled.toolName == "user_ask" { pendingQuestion = true }
            return
        }
        switch event.event {
        case "message-start":
            setStreaming(true)
            streamText = ""
            streamTextTruncated = false
            pendingDelta = ""
            clearLiveThinking()
            setActivity(nil)
        case "text-delta":
            if let payload = try? JSONDecoder().decode(DeltaPayload.self, from: data) {
                appendDelta(payload.delta)
            }
        case "queued":
            // Another turn holds the agent right now — the wait before
            // message-start is expected, not a stall. Tell the user.
            setStreaming(true)
            setActivity("Waiting for another task")
        case "message-end":
            let payload = try? JSONDecoder().decode(EndPayload.self, from: data)
            flushPendingDelta() // the streamText fallback must include the tail
            flushLiveThinking() // …and the reasoning row must show its last delta
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
            scheduleQueueDrain()
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
    /// Equality-gated like every other per-event write — @Observable has no
    /// same-value suppression, and the timeline body reads this. Internal (not
    /// private) for WalnutTests, which flush deterministically rather than
    /// waiting on the 120ms coalesce timer.
    func flushLiveThinking() {
        guard live.flush() else { return }
        if liveThinking != live.thinkingText { liveThinking = live.thinkingText }
    }

    /// Drop the live reasoning region. Called at a turn boundary, on teardown,
    /// and — the load-bearing one — from `loadMessages` once canonical history
    /// has landed, so the reasoning and the fetched `kind:"thinking"` rows are
    /// never both on screen.
    private func clearLiveThinking() {
        live.reset()
        if !liveThinking.isEmpty { liveThinking = "" }
        // `live.reset()` already dropped the turn's calls; the observed mirror has
        // to go with it or a finished turn's tool rows outlive their turn (this is
        // the handoff point where the canonical `kind:"tool"` rows take over).
        setLiveTools([])
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
    /// How often the watchdog looks, and how long a stream has to be silent before
    /// it reconciles. Named so a test can drive the REAL loop on a short clock
    /// instead of replacing it (see `startTurnWatchdogForTesting`).
    private static let watchdogPoll: Duration = .seconds(15)
    private static let watchdogSilence: TimeInterval = 30

    private func startTurnWatchdog(
        conversationID: String,
        poll: Duration = ChatStore.watchdogPoll,
        silentFor: TimeInterval = ChatStore.watchdogSilence
    ) {
        turnWatchdog?.cancel()
        lastSSEEventAt = Date()
        turnWatchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: poll)
                guard let self, self.isActive, !Task.isCancelled else { return }
                guard self.streaming, self.activeID == conversationID else { return }
                guard Date().timeIntervalSince(self.lastSSEEventAt) > silentFor else { continue }
                // Silent too long: reconcile against server history. What counts
                // as proof lives in `turnSettled` (the server's `inFlight` flag
                // first, the older-server heuristic behind it) and is banked by
                // the fetch below.
                await self.loadMessages(conversationID)
                guard self.streaming, self.activeID == conversationID else { return }
                // The verdict that fetch banked, NOT a re-read of `messages`: mid
                // turn the timeline deliberately holds only the settled prefix, so
                // asking it would answer "not over" forever.
                let turnOver = self.lastFetchSettledTurn == true
                if turnOver {
                    AppLog.error("chat", "turn watchdog reconciled a lost message-end", [
                        "conversationID": conversationID,
                        "silentFor": "\(Int(Date().timeIntervalSince(self.lastSSEEventAt)))s",
                    ])
                    self.adoptLostTurnEnd()
                    return
                }
            }
        }
    }

    /// Put the turn down after the watchdog proved it already ended.
    ///
    /// Factored out of the watchdog loop so the transition is reachable without
    /// waiting on the 15-second poll. It matters that the SAME code runs: a queue
    /// drained only from the `message-end` handler would strand on exactly the turn
    /// whose `message-end` was lost, and this is that turn.
    private func adoptLostTurnEnd() {
        streaming = false
        streamText = ""
        streamTextTruncated = false
        // Canonical history already landed, so the reasoning's handoff is
        // complete — retire the live region.
        clearLiveThinking()
        activity = nil
        scheduleQueueDrain()
    }

    /// Test seam: the watchdog's settle, run directly. Production code must reach
    /// it only through `startTurnWatchdog`.
    func adoptLostTurnEndForTesting() {
        adoptLostTurnEnd()
    }

    /// Test seam: the REAL watchdog loop, with only its two CLOCKS shortened.
    ///
    /// Production waits 15s between looks and wants 30s of silence, which no test
    /// can sit through — and replacing the loop would prove nothing about the loop,
    /// which is exactly the gap that let "the watchdog does not drain" ship once.
    func startTurnWatchdogForTesting(
        conversationID: String, silentFor: TimeInterval, poll: Duration
    ) {
        startTurnWatchdog(conversationID: conversationID, poll: poll, silentFor: silentFor)
    }

    /// Watchdog reconcile verdict: does fetched history PROVE the watched turn
    /// is over?
    ///
    /// FIRST, THE SERVER'S OWN ANSWER (`inFlight`, additive 2026-09-17): a row
    /// still marked in-flight is proof the turn is NOT over, whatever else the
    /// list holds. It comes first because the rule under it is no longer true on
    /// its own. "Assistant messages persist only at turn end, so a plain
    /// assistant row AFTER our watched user message is proof" held while a
    /// transcript gained its assistant text only at message-end; a lane
    /// transcript now carries the model's INTERMEDIATE text mid-turn (a
    /// "I will run the first command, then the second" row sits between two tool
    /// rows), so that premise settled a turn 30 to 44s into a tool call three
    /// times in one probe: `streaming` went false, the live region retired, the
    /// composer unlocked, and the refetched rows re-rendered the still-running
    /// tool with no output.
    ///
    /// The heuristic stays as the OLDER-SERVER fallback, unchanged, for a box
    /// that sends the field nowhere. When the watched user message is MISSING
    /// from the fetch, the copy is stale (a replica lagging git-sync) or the tail
    /// window slid past it. Never settle from evidence that predates our own
    /// send: the PREVIOUS turn's trailing reply would satisfy the naive
    /// last-is-assistant check and clear `streaming` mid-turn (2026-08-23
    /// dogfood round 10). The last-is-assistant fallback is only for the 409
    /// turn_active path, where there IS no watched text (someone else's turn).
    /// Internal for WalnutTests.
    /// The rows of a fetch that the timeline may INSTALL while a turn is running:
    /// everything up to and including the watched user row, and none of the rows
    /// belonging to the turn still in flight.
    ///
    /// WHY A MID-TURN FETCH MUST BE TRUNCATED: the LIVE region owns the current
    /// turn until message-end (or a true settle). Its tool rows know a call is
    /// still running and carry the previews the stream relays; the same call's
    /// MESSAGE row is built as a transcript row, where an absent `resultPreview`
    /// legitimately means "printed nothing". So installing the in-flight rows
    /// mid-turn replaced a correct live row with one that reported "No output"
    /// for a command that was still running (2026-09-17 gate, probe gsrnmo).
    ///
    /// Two rules, most authoritative first, mirroring `turnSettled`.
    nonisolated static func settledRows(_ fetched: [ChatMessage],
                                        watched: String?) -> [ChatMessage] {
        // The server says which rows are in flight. They are a contiguous tail by
        // contract, so cutting at the FIRST of them also keeps a row the server
        // forgot to flag from slipping in behind one it did.
        if let first = fetched.firstIndex(where: { $0.inFlight == true }) {
            return Array(fetched[..<first])
        }
        // Older server: the watched user row is the only boundary there is. With
        // no watched text, or none matching, NOTHING is dropped: guessing a
        // boundary is how a finished turn's rows would vanish from the timeline.
        //
        // Reached only while the verdict says the turn is still running, so this
        // covers the shape a box with no flags CAN be read correctly in (tool rows
        // after the user row, no prose yet). Once unflagged prose lands, that box
        // is indistinguishable from a finished turn and the turn is installed
        // whole, reply included: that ambiguity is what `inFlight` removes.
        guard let watched,
              let userIdx = fetched.lastIndex(where: { $0.role == "user" && $0.text == watched })
        else { return fetched }
        return Array(fetched[...userIdx])
    }

    nonisolated static func turnSettled(history: [ChatMessage], watched: String?) -> Bool {
        if history.contains(where: { $0.inFlight == true }) { return false }
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
                let turnID = "turn-\(Date().timeIntervalSince1970)"
                messages.append(ChatMessage(
                    id: turnID,
                    role: "assistant", text: fullText,
                    createdAt: ISO8601DateFormatter().string(from: .now), kind: nil
                ))
                // Tag the provisional reply with its conversation, so a later
                // merge can tell "the canonical reply has not landed yet" from
                // "this reply belongs to a conversation you have left".
                localRowConversation[turnID] = conversationID
            }
        }
        // Live row → provisional row shifts layout; keep the reader glued to
        // the end of the reply they were watching.
        if isActive && wasAtBottom { scrollToBottomSignal += 1 }
        scheduleQueueDrain()
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
            let result = try await sendTransport.stopConversation(
                id: id, agentID: activeAgentID
            )
            AppLog.info("chat", "turn stopped", ["conversationID": id, "stopped": String(result.stopped)])
            streaming = false
            streamText = ""
            streamTextTruncated = false
            activity = nil
            pendingQuestion = false
            turnWatchdog?.cancel()
            turnWatchdog = nil
            // A STOP STILL DELIVERS THE QUEUE, one turn at a time, and that is a
            // DELIBERATE divergence from the web console, which clears its queue on
            // stop (`useChat.ts` `clearQueue`). Stop is aimed at the turn that is
            // running; the banked messages are separate instructions the user typed
            // and asked for, and deleting someone's instructions without saying so is
            // the worse failure. Stranding them would be worse still: the drain's
            // triggers are turn ends and reconnects, so a queue not drained here has
            // no trigger left until the user happens to send something else.
            scheduleQueueDrain()
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
        // The drain belongs here too, and its absence was a second entrance to the
        // lost-bubble bug: `closeStream` clears `isActive` but an already-running
        // drain does not re-check it before its POST, so a backgrounded drain
        // finished its round trip and then marked a row in a timeline that had been
        // emptied underneath it. Cancelling is safe because a cancelled drain leaves
        // its entry on disk (`processing`), and the next launch decides.
        queueDrainTask?.cancel()
        queueDrainTask = nil
    }
}

extension ChatStore: LifecycleSuspendable {
    func suspendForBackground() { closeStream() }
    func resumeForForeground() { resumeStream() }
}
