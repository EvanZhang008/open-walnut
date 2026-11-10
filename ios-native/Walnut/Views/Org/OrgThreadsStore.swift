import Foundation
import Observation

/// One Org node's Threads as the phone holds them: read from the server, and written one action
/// at a time (Acknowledge, Snooze, Pin, Reopen, Follow up), each followed by a fresh read so the
/// page shows what the server keeps.
@Observable
@MainActor
final class OrgThreadsStore {
    let taskId: String
    /// nil until the first read answers.
    private(set) var threads: [OrgThread]?
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
    /// Where the last action moved its thread ("Moved to In progress"), shown for a moment.
    struct Notice: Equatable { let text: String; let id = UUID() }
    var notice: Notice?
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

    init(taskId: String, threads: [OrgThread]? = nil, cache: OrgThreadsCache? = .shared) {
        self.taskId = taskId
        self.threads = threads
        self.cache = cache
        if threads == nil, let entry = cache?.cached(taskId) { take(entry) }
    }

    private let cache: OrgThreadsCache?

    /// How often a page whose read failed asks again while it is on screen (`OrgNodePage`).
    nonisolated static let retrySeconds: Double = 5

    /// On screen: on a list only a read by id brought (a thread past the newest closed ones), so
    /// a reveal reads it by id again rather than trust that copy (`OrgThreadRevealModel`).
    var byIdOnly: Set<String> { Set(foundById.keys).subtracting(listIds) }

    private func take(_ entry: OrgThreadsCache.Entry) {
        threads = entry.threads
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

    func load() async {
        generation += 1
        let gen = generation
        let started = Date()
        loading = true
        defer { if gen == generation { loading = false } }
        do {
            let read: OrgThreadsRead
            do {
                read = try await WalnutAPI().orgThreads(taskId: taskId)
            } catch let first as APIError where first.isPrimaryOnly && (threads == nil || fromCache) {
                // Threads live on the Mac only: through the companion one read may land in a
                // moment it cannot reach the Mac (2026-11-08). The companion asks the Mac again
                // once it is heard (its beat is 15 s), so twice more within that before the page says so.
                // A page showing only the phone's copy has no fresh read yet either.
                read = try await retryUnavailable(gen: gen)
            }
            guard gen == generation else { return }
            listIds = Set(read.threads.map(\.id))
            threads = Self.merged(read.threads, keeping: foundById)
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
            self.error = Self.readError(hasThreads: threads != nil, fromCache: fromCache)
            AppLog.warn("org", "threads load failed", ["taskId": taskId, "error": error.localizedDescription])
        }
    }

    private func retryUnavailable(gen: Int) async throws -> OrgThreadsRead {
        var lastError: Error = APIError.cancelled
        for wait in [2_000, 8_000] {
            try await Task.sleep(for: .milliseconds(wait))
            guard gen == generation else { throw CancellationError() }
            do { return try await WalnutAPI().orgThreads(taskId: taskId) } catch let e as APIError where e.isPrimaryOnly {
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

    /// What a failed list read says, by what the page still shows.
    nonisolated static func readError(hasThreads: Bool, fromCache: Bool) -> String {
        if !hasThreads { return "Couldn't load the threads. Pull to try again." }
        if fromCache { return "These are the threads as the phone last saw them. Pull to try again." }
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
            threads = Self.afterFound(thread, threads: threads)
            probes[threadId] = .init(startedAt: started, result: .found)
        } catch APIError.server(let status, _, _, _, _) where status == 404 {
            let after = Self.afterGone(threadId, threads: threads, found: foundById, listIds: listIds)
            foundById = after.found
            threads = after.threads
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
              var list = threads, let i = list.firstIndex(where: { $0.id == threadId }),
              whole.updatedAt >= list[i].updatedAt else { return }
        list[i] = whole
        threads = list
    }

    /// One action on a thread. A failure leaves the thread as it was and says so.
    func edit(_ threadId: String, _ edit: OrgThreadEdit) async {
        busyThreadId = threadId
        defer { busyThreadId = nil }
        do {
            try await WalnutAPI().editOrgThread(taskId: taskId, threadId: threadId, edit)
            error = nil
        } catch {
            self.error = "Couldn't update the thread. Try again."
            AppLog.warn("org", "thread edit failed", ["taskId": taskId, "threadId": threadId, "error": error.localizedDescription])
            await load()
            return
        }
        await load()
        tellWhereItWent(threadId)
    }

    private func tellWhereItWent(_ threadId: String) {
        if let text = OrgThreadModel.movedNotice(threadId, threads: threads ?? [], now: Date().addingTimeInterval(AppClock.demoOffset)) {
            notice = Notice(text: text)
        }
    }

    /// A Follow up into the node's chat, filed under the thread. True when the server took it.
    func followUp(_ threadId: String, sessionId: String, text: String, images: [SelectedImage] = []) async -> Bool {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty || !images.isEmpty else { return false }
        busyThreadId = threadId
        defer { busyThreadId = nil }
        let messageId = SendRetryPolicy.newMessageId()
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
            _ = try await WalnutAPI().sendThreadFollowUp(
                sessionId: sessionId, threadId: threadId, text: words, images: payloads,
                messageId: messageId)
        } catch {
            AppLog.warn("org", "thread follow-up failed", ["taskId": taskId, "threadId": threadId, "error": error.localizedDescription])
            return false
        }
        followUpSentAt[threadId] = Date()
        // His reply makes it the node's move: out of his view at once, as the server's next read says.
        if let i = threads?.firstIndex(where: { $0.id == threadId }), let t = threads?[i] {
            threads?[i] = OrgThreadModel.afterHisFollowUp(t)
        }
        await load()
        tellWhereItWent(threadId)
        return true
    }
}
