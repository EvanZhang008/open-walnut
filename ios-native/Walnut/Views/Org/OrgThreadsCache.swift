import Foundation

/// The last threads read for each Org node, kept in memory and on disk (`DiskCache`, wiped with
/// every other cache on a disconnect). A node's page starts from them, so a push that opens the
/// page offline shows the threads as the phone last saw them, not "Couldn't load" (2026-11-08
/// review, round 2: a new page started with an empty store while the notice said "as the phone
/// last saw it").
@MainActor
final class OrgThreadsCache {
    static let shared = OrgThreadsCache()

    struct Entry: Codable, Equatable {
        let threads: [OrgThread]
        let shownCount: Int?
        let closedCount: Int?
        let savedAt: Date
    }

    /// Nodes kept, the most recently read first; older ones go.
    nonisolated static let maxNodes = 12

    private var memory: [String: Entry] = [:]
    private var order: [String] = []
    /// Nodes looked up on disk already (found or not), so a miss is not read again.
    private var looked: Set<String> = []
    /// Disk reads on their way, per node: every caller of `load` waits for the same one.
    private var reading: [String: Task<Entry?, Never>] = [:]

    private init() {}

    nonisolated static func key(_ taskId: String) -> String { "org-threads-\(taskId)" }

    /// What memory holds for the node now (a page's first frame).
    func cached(_ taskId: String) -> Entry? { memory[taskId] }

    /// Memory first, then disk once. A second caller while the disk read is on its way waits for
    /// that read: it was answered "nothing" before, so a cold offline open (its notice asked
    /// whether a copy exists a moment before the page asked for the copy) showed an empty page
    /// over a copy the phone held (2026-11-09 fleet run, round 3).
    func load(_ taskId: String) async -> Entry? {
        if let entry = memory[taskId] { return entry }
        if let inFlight = reading[taskId] { return await inFlight.value }
        guard !looked.contains(taskId) else { return nil }
        let key = Self.key(taskId)
        let read = Task { await DiskCache.loadAsync(Entry.self, key: key) }
        reading[taskId] = read
        let entry = await read.value
        reading[taskId] = nil
        looked.insert(taskId)
        guard let entry else { return memory[taskId] }
        // A read that landed meanwhile is newer.
        if memory[taskId] == nil { remember(taskId, entry) }
        return memory[taskId]
    }

    func has(_ taskId: String) async -> Bool { await load(taskId) != nil }

    /// A list read that answered.
    func save(_ taskId: String, threads: [OrgThread], shownCount: Int?, closedCount: Int?, now: Date = Date()) {
        let entry = Entry(threads: threads, shownCount: shownCount, closedCount: closedCount, savedAt: now)
        remember(taskId, entry)
        DiskCache.save(entry, key: Self.key(taskId))
    }

    /// A thread the server no longer has for him leaves the copy too.
    func drop(_ threadId: String, from taskId: String) {
        guard let entry = memory[taskId], entry.threads.contains(where: { $0.id == threadId }) else { return }
        save(taskId, threads: entry.threads.filter { $0.id != threadId }, shownCount: entry.shownCount,
             closedCount: entry.closedCount, now: entry.savedAt)
    }

    private func remember(_ taskId: String, _ entry: Entry) {
        memory[taskId] = entry
        looked.insert(taskId)
        order.removeAll { $0 == taskId }
        order.insert(taskId, at: 0)
        for old in order.dropFirst(Self.maxNodes) {
            memory[old] = nil
            DiskCache.remove(key: Self.key(old))
        }
        order = Array(order.prefix(Self.maxNodes))
    }

    /// Disconnect: the copies go with the pairing (the disk side goes with `DiskCache.clearAll`).
    func eraseAll() {
        memory.removeAll()
        order.removeAll()
        looked.removeAll()
        reading.removeAll()
    }
}
