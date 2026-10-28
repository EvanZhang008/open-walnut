import Foundation

/// Where an html-app island's state lives between one build of its document and the
/// next: the phone twin of the web console's `island-store.ts`, same semantics.
///
/// One record per island: what its page wrote to `localStorage` (`IslandRuntime`) and
/// the last result it offered the AI, with whether the user sent it. An island is named
/// by its conversation (the timeline scope, i.e. the session or chat id) and the content
/// key of its own html, never by a row id: the same quiz is the same island while it
/// streams, after the live row settles into history, and after a relaunch.
///
/// Kept in memory and persisted to the app's preferences (`AppPrefs`), debounced, and
/// flushed when the app goes to the background. Bounded: at most `limit` islands, the
/// least recently written evicted first, and a store over `IslandRuntime.stateMax`
/// characters is refused (the page keeps running; the record keeps its old store).
///
/// Thread safety: the layout actor reads a record's result while it builds rows (the
/// result strip is part of the island row's height), so every access goes through a
/// lock. Writes come from the main thread (the web view's message handler, the sheet).
final class IslandStateStore: @unchecked Sendable {
    static let shared = IslandStateStore()

    struct Result: Codable, Equatable {
        var text: String
        /// The user pressed Send and the conversation accepted it.
        var sent: Bool
        /// The user dismissed this text: the same text offered again stays hidden
        /// (optional, so records an older build wrote still decode).
        var dismissed: Bool? = nil
    }

    struct Record: Codable, Equatable {
        var items: [String: String]
        var result: Result?
        /// Milliseconds since 1970 of the last write, for eviction.
        var at: Double
    }

    /// Posted on the main thread when a record's RESULT changed (offered, sent,
    /// dismissed). `userInfo["key"]` is the store key, `userInfo["islandKey"]` the
    /// island's content key. State writes post nothing: no one draws from them.
    static let resultChanged = Notification.Name("walnut.islandResultChanged")

    static let storageKey = "walnut.islandState"
    /// Islands kept. A quiz is a few hundred bytes; this is a long tail of them.
    static let limit = 200
    /// Ceiling on everything kept, so a handful of large islands cannot turn the
    /// preferences file into a database. The oldest islands go first.
    static let totalMax = 2 * 1024 * 1024

    private let lock = NSLock()
    private var records: [String: Record] = [:]
    private let storedDefaults: UserDefaults
    private var defaults: UserDefaults { AppPrefs.resolve(storedDefaults) }
    private let persistDelay: TimeInterval
    private var persistScheduled = false
    private let now: () -> Double

    init(defaults: UserDefaults = .standard, persistDelay: TimeInterval = 0.5,
         now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.storedDefaults = defaults
        self.persistDelay = persistDelay
        self.now = now
        if let data = AppPrefs.resolve(defaults).data(forKey: Self.storageKey),
           let stored = try? JSONDecoder().decode([String: Record].self, from: data) {
            records = stored
        }
        // The debounced write's durability edge: iOS only ends an app after it went
        // to the background, so flushing there keeps the last answer of a quiz.
        if defaults === UserDefaults.standard {
            Task { @MainActor [weak self] in
                guard let self else { return }
                LifecycleHub.shared.register(self)
            }
        }
    }

    // MARK: - Keys

    /// The record's name: "<scope>|<island content key>".
    static func storeKey(scope: String, islandKey: String) -> String {
        "\(scope)\(TimelineScope.separator)\(islandKey)"
    }

    /// The store key for an island row. A row id is "<scope>|<message>#<n>" (see
    /// `TimelineScope`), and the scope is the conversation, the same for the live row
    /// and the settled one. An unscoped id has no scope. The message id is left out on
    /// purpose, though the web key holds it: a live row's id is the run's and the
    /// settled row's is the server's, so keying by it would lose the state at exactly
    /// the moment the user reported (the reply settling). The cost: the same island,
    /// byte for byte, in a later reply of the same conversation resumes where it was.
    static func storeKey(rowID: String, islandKey: String) -> String {
        let scope = rowID.firstIndex(of: TimelineScope.separator).map { String(rowID[..<$0]) } ?? ""
        return storeKey(scope: scope, islandKey: islandKey)
    }

    /// The island's content key from a store key (the part after the scope).
    static func islandKey(fromStoreKey key: String) -> String {
        guard let cut = key.lastIndex(of: TimelineScope.separator) else { return key }
        return String(key[key.index(after: cut)...])
    }

    // MARK: - Reads

    func record(_ key: String) -> Record? {
        lock.lock()
        defer { lock.unlock() }
        return records[key]
    }

    func items(_ key: String) -> [String: String] { record(key)?.items ?? [:] }

    /// The result to show: none once the user dismissed it.
    func result(_ key: String) -> Result? {
        guard let result = record(key)?.result, result.dismissed != true else { return nil }
        return result
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return records.count
    }

    // MARK: - Writes

    /// Keep what the page wrote. A store past the cap is refused and the old one kept.
    @discardableResult
    func saveItems(_ items: [String: String], key: String) -> Bool {
        guard IslandRuntime.serializedLength(items) <= IslandRuntime.stateMax else {
            AppLog.debug("island", "state refused", ["key": key,
                                                    "chars": String(IslandRuntime.serializedLength(items))])
            return false
        }
        let old = record(key)
        guard old?.items != items else { return true }
        write(key, Record(items: items, result: old?.result, at: now()))
        return true
    }

    /// The page offered a result. The same text it already offered keeps its sent and
    /// dismissed marks, so a page that reports again on load does not ask the user to
    /// send twice, nor bring back what they dismissed.
    @discardableResult
    func offerResult(_ text: String, key: String) -> Result {
        let old = record(key)
        let result = old?.result?.text == text ? old!.result! : Result(text: text, sent: false)
        write(key, Record(items: old?.items ?? [:], result: result, at: now()))
        if old?.result != result { announce(key) }
        return result
    }

    /// The user's Send was accepted. Only for the text still on offer: a page that
    /// reported something new while the send was in flight keeps its new result.
    func markSent(key: String, text: String) {
        guard let old = record(key), old.result?.text == text, old.result?.sent == false else { return }
        write(key, Record(items: old.items, result: Result(text: text, sent: true, dismissed: old.result?.dismissed), at: now()))
        announce(key)
    }

    func dismissResult(key: String) {
        guard let old = record(key), var result = old.result else { return }
        result.dismissed = true
        write(key, Record(items: old.items, result: result, at: now()))
        announce(key)
    }

    /// Disconnect, leaving the demo, or a test: forget every island (or every island
    /// of one scope), in memory and on disk.
    func removeAll(scope: String? = nil) {
        lock.lock()
        if let scope {
            let prefix = "\(scope)\(TimelineScope.separator)"
            records = records.filter { !$0.key.hasPrefix(prefix) }
        } else {
            records.removeAll()
        }
        lock.unlock()
        persistNow()
    }

    // MARK: - Internals

    private func write(_ key: String, _ record: Record) {
        lock.lock()
        // An empty record removes the island: a page that cleared its storage and has
        // no result is a page with nothing to keep.
        if record.items.isEmpty && record.result == nil {
            records[key] = nil
        } else {
            records[key] = record
            evictLocked(keeping: key)
        }
        lock.unlock()
        schedulePersist()
    }

    /// Lock held. Oldest written first, never the island just written.
    private func evictLocked(keeping key: String) {
        if records.count > Self.limit {
            let victims = records.filter { $0.key != key }
                .sorted { $0.value.at < $1.value.at }
                .prefix(records.count - Self.limit)
            for victim in victims { records[victim.key] = nil }
        }
        var total = records.reduce(0) { $0 + Self.size(of: $1.value) + $1.key.utf8.count }
        guard total > Self.totalMax else { return }
        for victim in records.filter({ $0.key != key }).sorted(by: { $0.value.at < $1.value.at }) {
            guard total > Self.totalMax else { break }
            total -= Self.size(of: victim.value) + victim.key.utf8.count
            records[victim.key] = nil
        }
    }

    private static func size(of record: Record) -> Int {
        record.items.reduce(0) { $0 + $1.key.utf8.count + $1.value.utf8.count }
            + (record.result?.text.utf8.count ?? 0) + 32
    }

    private func announce(_ key: String) {
        let post = {
            NotificationCenter.default.post(
                name: Self.resultChanged, object: self,
                userInfo: ["key": key, "islandKey": Self.islandKey(fromStoreKey: key)])
        }
        if Thread.isMainThread { post() } else { DispatchQueue.main.async(execute: post) }
    }

    private func schedulePersist() {
        lock.lock()
        let already = persistScheduled
        persistScheduled = true
        lock.unlock()
        guard !already else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + persistDelay) { [weak self] in
            self?.persistNow()
        }
    }

    /// Write the whole table now (also the background flush).
    func persistNow() {
        lock.lock()
        persistScheduled = false
        let snapshot = records
        lock.unlock()
        if snapshot.isEmpty {
            defaults.removeObject(forKey: Self.storageKey)
        } else if let data = try? JSONEncoder().encode(snapshot) {
            defaults.set(data, forKey: Self.storageKey)
        }
    }
}

extension IslandStateStore: LifecycleSuspendable {
    func suspendForBackground() { persistNow() }
    func resumeForForeground() {}
}
