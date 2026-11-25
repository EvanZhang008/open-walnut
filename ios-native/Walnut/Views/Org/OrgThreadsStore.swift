import Foundation
import Observation

/// One Org node's Threads as the phone holds them: ONE store per node (`forNode`), read by every
/// surface that shows them (the Org page, a task's Threads sheet), so a thread acted on in one is
/// already changed in the other.
///
/// An action (Acknowledge, Snooze, Pin, Reopen, Follow up) shows on the tap: the card moves, and
/// the node's count (its row in the Org list, the Threads switch, the bar under its chat) moves
/// with it through a status prediction on the node's task (`TasksStore.predictStatus`). A read or
/// a live event that lands while the write is out keeps the change laid over it; a refused write
/// takes it back and says so. Every change is read again from the server after, and a change made
/// elsewhere comes in live (`FeedSignals`) while a surface shows the node.
@Observable
@MainActor
final class OrgThreadsStore {
    let taskId: String
    /// What every surface draws: the last read with his changes still on their way laid over it.
    /// nil until the first read answers.
    private(set) var threads: [OrgThread]?
    /// The server's list as last read (plus the threads read by id), under his pending changes.
    @ObservationIgnored private var readThreads: [OrgThread]?
    /// His changes on their way, per thread, with the moment he made each (its stamp).
    @ObservationIgnored private var pending: [String: (change: OrgThreadChange, at: Date, token: Int)] = [:]
    @ObservationIgnored private var pendingSeq = 0
    /// When the last write was answered: the server's statuses for it may still be on their way.
    @ObservationIgnored private var settledAt = Date.distantPast
    /// The server counts this node's threads into its status (seen once on its row).
    @ObservationIgnored private var counted = false
    private(set) var error: String?
    /// How many threads his view shows by the server's count in the last read (nil: an older
    /// server that sends none).
    private(set) var shownCount: Int?
    /// All the node's closed threads by the server's count (the read brings the newest only).
    private(set) var closedCount: Int?
    /// The thread an action is running on (its buttons wait).
    private(set) var busyThreadId: String?
    private(set) var loading = false
    /// When a Follow up of his went out, per thread: the card says so at once, whatever the reload shows.
    private(set) var followUpSentAt: [String: Date] = [:]
    /// Where the last action moved its thread ("Moved to Working"), shown for a moment as a
    /// passing notice (`NoticeCenter`); `threadId` so a restore of that thread (a refused write)
    /// takes its notice back.
    struct Notice: Equatable { let text: String; var threadId: String? = nil; let id = UUID() }
    var notice: Notice? {
        didSet {
            guard let notice else { return }
            NoticeCenter.shared.post(NoticeItem(
                id: "org.threads.notice", title: "Threads", status: "Moved", tone: .ok, preview: notice.text,
                avatar: .symbol("bubble.left.and.text.bubble.right")))
        }
    }
    /// The last read that finished (its start, and whether it failed): a thread asked for after
    /// that start may not be in it yet (`OrgThreadRevealModel`).
    private(set) var lastRead: OrgThreadRevealModel.Read?
    /// Threads asked for by id that the list did not hold (`probe`), and what each read found.
    private(set) var probes: [String: OrgThreadRevealModel.Probe] = [:]
    /// The threads those reads found: kept on the list until a list read brings them itself, or a
    /// read by id says they are gone.
    @ObservationIgnored private var foundById: [String: OrgThread] = [:]
    /// The ids the last list read brought itself.
    @ObservationIgnored private var listIds: Set<String> = []
    /// The threads shown are the phone's copy from an earlier read (`OrgThreadsCache`), not one
    /// this page made.
    private(set) var fromCache = false
    @ObservationIgnored private var probing: Set<String> = []
    @ObservationIgnored private var generation = 0

    /// `write` and `tasks` are seams for WalnutTests: the server's PATCH, and the store whose node
    /// row carries the predicted count (the app's own `TasksStore` by default).
    init(taskId: String, threads: [OrgThread]? = nil, cache: OrgThreadsCache? = .shared,
         read: (() async throws -> OrgThreadsRead)? = nil,
         write: ((String, OrgThreadEdit) async throws -> Void)? = nil,
         tasks: (@MainActor () -> TasksStore?)? = nil, signals: FeedSignals? = nil) {
        self.taskId = taskId
        self.signals = signals
        self.readThreads = threads
        self.threads = threads
        self.cache = cache
        self.read = read ?? { try await WalnutAPI().orgThreads(taskId: taskId) }
        self.write = write ?? { threadId, edit in
            try await WalnutAPI().editOrgThread(taskId: taskId, threadId: threadId, edit)
        }
        self.tasksStore = tasks ?? { TasksStore.shared }
        if threads == nil, let entry = cache?.cached(taskId) { take(entry) }
        refetch = CoalescedRefetch { [weak self] in await self?.load() }
    }

    @ObservationIgnored private let cache: OrgThreadsCache?
    @ObservationIgnored private let read: () async throws -> OrgThreadsRead
    @ObservationIgnored private let write: (String, OrgThreadEdit) async throws -> Void
    @ObservationIgnored private let tasksStore: @MainActor () -> TasksStore?
    /// nil: the app's feed (`FeedSignals.shared`).
    @ObservationIgnored private let signals: FeedSignals?

    // MARK: - One store per node

    private static var nodes: [String: OrgThreadsStore] = [:]

    /// The node's store, made on first use: every surface of the node reads this one.
    static func forNode(_ taskId: String) -> OrgThreadsStore {
        if let store = nodes[taskId] { return store }
        let store = OrgThreadsStore(taskId: taskId)
        nodes[taskId] = store
        return store
    }

    /// A disconnect: no node's threads outlive the pairing (`LocalDataReset`).
    static func eraseAll() {
        for store in nodes.values { store.stopFollowing() }
        nodes = [:]
    }

    // MARK: - Live while shown

    /// Surfaces showing this node now: while any does, a change the feed reports is read again.
    @ObservationIgnored private var viewers = 0
    @ObservationIgnored private var signalToken: Int?
    @ObservationIgnored private var refetch: CoalescedRefetch?

    func viewerAppeared() {
        viewers += 1
        guard signalToken == nil else { return }
        signalToken = (signals ?? .shared).listen { [weak self] signal in self?.heard(signal) }
    }

    func viewerLeft() {
        viewers = max(0, viewers - 1)
        if viewers == 0 { stopFollowing() }
    }

    private func stopFollowing() {
        if let signalToken { (signals ?? .shared).stopListening(signalToken) }
        signalToken = nil
        refetch?.cancel()
    }

    /// `threads-changed` for this node (a newer server), a move of the node's status (every server:
    /// its counts are its threads), or a reconnect.
    func heard(_ signal: FeedSignals.Signal) {
        // Shown nowhere: the next surface to open it reads it anyway.
        guard signalToken != nil else { return }
        switch signal {
        case .threadsChanged(let id), .statusChanged(let id):
            guard id == taskId else { return }
        case .resynced:
            break
        case .inboxChanged:
            return
        }
        refetch?.ask()
    }

    /// Recompute what the surfaces draw from the read and the changes on their way.
    private func redraw() {
        guard let read = readThreads else {
            if threads != nil { threads = nil }
            return
        }
        let drawn = pending.isEmpty ? read : read.map { t in
            pending[t.id].map { OrgThreadModel.optimistic(t, $0.change, now: $0.at) } ?? t
        }
        if drawn != threads { threads = drawn }
    }

    /// The node's row reads its counts off the task's status: predicted from the list as drawn
    /// now, and made again from it each time the server speaks while writes are out or just
    /// answered (the status the server derived for the first of two acts is not the last word).
    private func predictNode() -> () -> Void {
        guard readThreads != nil, let tasks = tasksStore() else { return {} }
        // A read that brought none of the threads the counts name cannot be counted from.
        if readThreads?.isEmpty == true, (shownCount ?? 0) > 0 { return {} }
        return tasks.predictStatus(taskId, live: { [weak self] in self?.writesOut ?? false }) { [weak self] row in
            guard let self else { return row.userStatus }
            // Once its status carried counts, the server counts this node: a prediction of none
            // left (no `threads` at all) must still be counted up again.
            if row.userStatus?.threads != nil { self.counted = true }
            return OrgThreadModel.status(row.userStatus, withThreadsOf: self.threads ?? [], counted: self.counted,
                                         now: AppClock.now())
        }
    }

    private var writesOut: Bool {
        !pending.isEmpty || Date().timeIntervalSince(settledAt) < Self.settleSeconds
    }

    /// How long after a write's answer the server's derived status for an EARLIER write may still land.
    nonisolated static let settleSeconds: Double = 3

    /// One change of his on its way.
    struct Change { let threadId: String; let change: OrgThreadChange; let at: Date; let token: Int }

    /// His change shows now.
    private func begin(_ threadId: String, _ change: OrgThreadChange) -> Change {
        pendingSeq += 1
        let c = Change(threadId: threadId, change: change, at: AppClock.now(), token: pendingSeq)
        pending[threadId] = (change, c.at, c.token)
        redraw()
        return c
    }

    /// The write was answered. Saved: the change is part of the list now, so nothing draws back
    /// while the read after it is out, also when a newer tap on the same thread is still on its
    /// way (that one stays laid over it). Only the change this token made leaves `pending`.
    private func settle(_ c: Change, saved: Bool) {
        settledAt = Date()
        // A read that left before this answer is older than the change, but every write is read
        // again after its answer, and that newer read supersedes it (`generation`).
        if saved, var list = readThreads, let i = list.firstIndex(where: { $0.id == c.threadId }) {
            list[i] = OrgThreadModel.optimistic(list[i], c.change, now: c.at)
            readThreads = list
        }
        if pending[c.threadId]?.token == c.token { pending[c.threadId] = nil }
        redraw()
    }

    /// How often a page whose read failed asks again while it is on screen (`OrgNodePage`).
    nonisolated static let retrySeconds: Double = 5

    /// On screen: on a list only a read by id brought (a thread past the newest closed ones), so
    /// a reveal reads it by id again rather than trust that copy (`OrgThreadRevealModel`).
    var byIdOnly: Set<String> { Set(foundById.keys).subtracting(listIds) }

    private func take(_ entry: OrgThreadsCache.Entry) {
        readThreads = entry.threads
        redraw()
        listIds = Set(entry.threads.map(\.id))
        shownCount = entry.shownCount
        closedCount = entry.closedCount
        fromCache = true
    }

    /// The phone's last copy from disk, before the first read answers (a page opened offline).
    func hydrate() async {
        guard threads == nil, let entry = await cache?.load(taskId), threads == nil else { return }
        take(entry)
    }

    /// The native refresh task can be cancelled once the pull ends. Keep its bounded read and
    /// reconnect attempts alive; a newer load still supersedes them through the generation fence.
    func refresh() async {
        await Task { await self.load() }.value
    }

    func load() async {
        generation += 1
        let gen = generation
        let started = Date()
        loading = true
        defer { if gen == generation { loading = false } }
        do {
            let read: OrgThreadsRead
            do {
                read = try await self.read()
            } catch let first as APIError where first.isLeaderUnreachableForNow {
                // A refresh needs the same reconnect window as a first read, even with threads on screen.
                read = try await retryUnavailable(gen: gen)
            }
            guard gen == generation else { return }
            listIds = Set(read.threads.map(\.id))
            readThreads = Self.merged(read.threads, keeping: foundById)
            redraw()
            // A failed read by id is asked again now that the list could be read.
            probes = probes.filter { $0.value.result != .failed }
            shownCount = read.shownCount
            closedCount = read.closedCount
            error = nil
            fromCache = false
            lastRead = .init(startedAt: started, failed: false)
            OrgReadNews.shared.answered()
            cache?.save(taskId, threads: read.threads, shownCount: read.shownCount, closedCount: read.closedCount)
            // A thread only a read by id holds is asked again: it may be gone since.
            for id in byIdOnly { Task { await probe(id) } }
        } catch {
            guard gen == generation else { return }
            if let api = error as? APIError, api.isCancelled { return }
            if error is CancellationError { return }
            // Nothing on the page yet: the phone's copy, if it holds one, before the page says
            // it could not load (a read that failed before the copy came off the disk).
            if threads == nil { await hydrate() }
            guard gen == generation else { return }
            lastRead = .init(startedAt: started, failed: true)
            self.error = Self.readError(hasThreads: threads != nil, fromCache: fromCache, cause: error as? APIError)
            AppLog.warn("org", "threads load failed", ["taskId": taskId, "error": error.localizedDescription])
        }
    }

    private func retryUnavailable(gen: Int) async throws -> OrgThreadsRead {
        var lastError: Error = APIError.cancelled
        for wait in [2_000, 8_000, 8_000] {
            try await Task.sleep(for: .milliseconds(wait))
            guard gen == generation else { throw CancellationError() }
            do { return try await read() } catch let e as APIError where e.isLeaderUnreachableForNow {
                lastError = e
            }
        }
        throw lastError
    }

    /// The list as read, plus the threads read by id it does not hold (a closed one past the
    /// newest the read brings). The list's own copy wins.
    nonisolated static func merged(_ list: [OrgThread], keeping found: [String: OrgThread]) -> [OrgThread] {
        let ids = Set(list.map(\.id))
        return list + found.values.filter { !ids.contains($0.id) }.sorted { $0.id < $1.id }
    }

    /// After a read by id brought `thread`: the newest read of it wins, so its copy replaces the
    /// one the page holds (an earlier read by id, or a list read older than this one), in place.
    /// `merged` keeps the list's own copy, which is right for a list read and wrong here: a
    /// second push for an old closed thread revealed the copy the first push had read, whatever
    /// the server said since (2026-11-08 review, round 3).
    nonisolated static func afterFound(_ thread: OrgThread, threads: [OrgThread]?) -> [OrgThread] {
        var list = threads ?? []
        if let i = list.firstIndex(where: { $0.id == thread.id }) {
            list[i] = thread
        } else {
            list.append(thread)
        }
        return list
    }

    /// The count the Threads switch shows: the threads for him on the page (or the counts the
    /// page itself names when its read brought none of them); before any read, the node's own
    /// count. Nil, no number, when no read could be made and nothing is on the page: a count of
    /// threads the page cannot show is a claim it cannot back (2026-11-09 fleet run: "Threads 14"
    /// over "Couldn't load the threads").
    nonisolated static func tabCount(read: Int?, serverCount: Int?, nodeCount: Int?, readFailed: Bool) -> Int? {
        if let read { return OrgThreadModel.unreadCount(serverCount: serverCount, nodeCount: nodeCount, read: read) ?? read }
        if readFailed { return nil }
        return nodeCount ?? 0
    }

    /// Which server could not reach the Mac, in its own words: every replica answers this (the cloud
    /// companion, the Walnut server on a host), so the phone names none itself.
    nonisolated static func unreachableSentence(_ cause: APIError) -> String {
        if case .server(_, _, let sentence, _, _) = cause {
            let trimmed = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed.last.map { ".!?".contains($0) } == true ? trimmed : trimmed + "." }
        }
        return "Walnut couldn't reach your Mac for the threads just now."
    }

    nonisolated private static func isOutOfReach(_ cause: APIError) -> Bool {
        if case .network = cause { return true }
        return false
    }

    /// What a failed list read says, by what the page still shows.
    nonisolated static func readError(hasThreads: Bool, fromCache: Bool, cause: APIError? = nil) -> String {
        if let cause, cause.isLeaderUnreachableForNow {
            let kept = hasThreads ? " The threads shown here have not been refreshed." : ""
            return "\(unreachableSentence(cause))\(kept) It will try again automatically."
        }
        if !hasThreads { return "Couldn't load the threads. Pull to try again." }
        // Out of reach, the threads shown are the phone's last copy whether it came off the disk
        // or from a read earlier in this run (every surface of a node shares one store since
        // bfc9160a2e), and the page says what the open's notice says (ThreadPushNavigation Y).
        if fromCache || cause.map(Self.isOutOfReach) == true {
            return "These are the threads as the phone last saw them. Pull to try again."
        }
        return "Couldn't refresh the threads."
    }

    /// After a read by id answered "not his" (404): the copy it had brought goes, unless the list
    /// read brought the thread itself.
    nonisolated static func afterGone(
        _ threadId: String, threads: [OrgThread]?, found: [String: OrgThread], listIds: Set<String>
    ) -> (threads: [OrgThread]?, found: [String: OrgThread]) {
        var found = found
        found[threadId] = nil
        guard !listIds.contains(threadId) else { return (threads, found) }
        return (threads?.filter { $0.id != threadId }, found)
    }

    /// A thread asked for (a push) that the list read does not hold: read it by its id before
    /// the page says it is gone. Found, it joins the list where its state puts it; a 404 is the
    /// only answer that it is no longer there; anything else is a failed check.
    func probe(_ threadId: String) async {
        guard !probing.contains(threadId) else { return }
        probing.insert(threadId)
        defer { probing.remove(threadId) }
        let started = Date()
        do {
            let thread = try await WalnutAPI().orgThread(taskId: taskId, threadId: threadId)
            foundById[threadId] = thread
            readThreads = Self.afterFound(thread, threads: readThreads)
            redraw()
            probes[threadId] = .init(startedAt: started, result: .found)
        } catch APIError.server(let status, _, _, _, _) where status == 404 {
            let after = Self.afterGone(threadId, threads: readThreads, found: foundById, listIds: listIds)
            foundById = after.found
            readThreads = after.threads
            redraw()
            if !listIds.contains(threadId) { cache?.drop(threadId, from: taskId) }
            probes[threadId] = .init(startedAt: started, result: .notFound)
        } catch {
            if let api = error as? APIError, api.isCancelled { return }
            probes[threadId] = .init(startedAt: started, result: .failed)
            AppLog.warn("org", "thread read by id failed", ["taskId": taskId, "threadId": threadId, "error": error.localizedDescription])
        }
    }

    /// One thread read whole in place of its cut copy (a Conversation opened). An older server
    /// without the route, or a failed read, leaves the cut copy, which says where the rest is.
    func loadWhole(_ threadId: String) async {
        let gen = generation
        guard let whole = try? await WalnutAPI().orgThread(taskId: taskId, threadId: threadId),
              // A list read that started meanwhile is newer than this copy: keep it.
              gen == generation,
              var list = readThreads, let i = list.firstIndex(where: { $0.id == threadId }),
              whole.updatedAt >= list[i].updatedAt else { return }
        list[i] = whole
        readThreads = list
        redraw()
    }

    /// One action on a thread: the card and the node's count change on the tap, the write goes,
    /// and the threads are read again. A refusal puts the thread and the count back and says so.
    func edit(_ threadId: String, _ edit: OrgThreadEdit) async {
        let change = begin(threadId, .edit(edit))
        let unpredict = predictNode()
        if OrgThreadModel.tellsWhereItWent(after: edit) { tellWhereItWent(threadId) }
        do {
            try await write(threadId, edit)
            settle(change, saved: true)
            error = nil
            await load()
        } catch {
            settle(change, saved: false)
            refused(unpredict, threadId: threadId)
            AppLog.warn("org", "thread edit failed", ["taskId": taskId, "threadId": threadId, "error": error.localizedDescription])
            await load()
            // Said after the read, which clears a read's own error: the refusal stays on the page.
            self.error = Self.refusedWords
        }
    }

    /// What a refused change says, short: the card is back where it was.
    nonisolated static let refusedWords = "Couldn't update the thread. It is back as it was. Try again."

    /// A refused write: the count goes back, and is made again from the list as drawn now if
    /// another change of this node is still on its way. The notice about it goes too.
    private func refused(_ unpredict: () -> Void, threadId: String) {
        unpredict()
        _ = predictNode()
        if notice?.threadId == threadId { notice = nil }
    }

    private func tellWhereItWent(_ threadId: String) {
        if let text = OrgThreadModel.movedNotice(threadId, threads: threads ?? [], now: AppClock.now()) {
            notice = Notice(text: text, threadId: threadId)
        }
    }

    /// A Follow up into the node's chat, filed under the thread. True when the server took it.
    func followUp(_ threadId: String, sessionId: String, text: String, images: [SelectedImage] = []) async -> Bool {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty || !images.isEmpty else { return false }
        busyThreadId = threadId
        defer { busyThreadId = nil }
        // His reply makes it the node's move: out of his view at once, the node's count with it.
        let change = begin(threadId, .followUp)
        let unpredict = predictNode()
        let messageId = SendRetryPolicy.newMessageId()
        let receipt: SessionSendReceipt
        do {
            // The thread first: through the companion the words reach the Mac without it, and the
            // thread he answered stayed on his view (2026-11-10). An older Mac, or one out of
            // reach, answers an error: the words still go, filed by Walnut's own pick.
            do {
                try await WalnutAPI().announceThreadFollowUp(taskId: taskId, threadId: threadId, messageId: messageId)
            } catch {
                AppLog.warn("org", "thread follow-up not announced", ["taskId": taskId, "threadId": threadId, "error": error.localizedDescription])
            }
            let payloads = await SelectedImage.buildPayloads(images.map(\.jpegData))
            receipt = try await WalnutAPI().sendThreadFollowUp(
                sessionId: sessionId, threadId: threadId, text: words, images: payloads,
                messageId: messageId)
        } catch {
            settle(change, saved: false)
            refused(unpredict, threadId: threadId)
            AppLog.warn("org", "thread follow-up failed", ["taskId": taskId, "threadId": threadId, "error": error.localizedDescription])
            return false
        }
        followUpSentAt[threadId] = Date()
        // A send the companion holds has not reached the Mac yet, so the next read still shows it:
        // the card goes back to what the server keeps, and says the follow-up went.
        if receipt.queued {
            settle(change, saved: false)
            refused(unpredict, threadId: threadId)
        } else {
            settle(change, saved: true)
        }
        await load()
        tellWhereItWent(threadId)
        return true
    }
}
