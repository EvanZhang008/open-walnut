import Foundation

/// Everything the Health sync remembers between runs. Small and plain: anchors
/// are opaque archived `HKQueryAnchor`s (NSKeyedArchiver with secure coding,
/// made and read by the data source), so this file never imports HealthKit.
struct HealthSyncSnapshot: Codable, Equatable, Sendable {
    /// The Mac's store id the anchors belong to. A different id means the Mac's
    /// copy was deleted: every anchor is void.
    var storeId: String?
    /// Random per install, sent as `device.installId`.
    var installId: String?
    /// Per type: where the next anchored query starts.
    var anchors: [String: Data] = [:]
    /// Raw types whose last 7 days went out ahead of the backfill.
    var primed: Set<String> = []
    /// Types whose history reached the end at least once.
    var completed: Set<String> = []
    /// Bucket types: the earliest start of samples seen since the last
    /// successful recompute. Persisted together with the anchor, so the anchor
    /// may advance before the POST without losing what must be recomputed.
    var bucketPendingFrom: [String: Date] = [:]
    /// Bucket types that saw a deletion: the recompute also sends empty buckets.
    var bucketPendingDeletes: Set<String> = []
    /// Bucket types: the earliest sample ever seen (a deletion recomputes from here).
    var bucketEarliest: [String: Date] = [:]
    /// Bucket types: the high-water mark, when buckets were last recomputed and sent.
    var bucketSentThrough: [String: Date] = [:]
    /// Characteristic name → uuid last sent (`char-<name>-<code>`).
    var characteristicUUIDs: [String: String] = [:]
    var lastFullSyncAt: Date?
    var lastSuccessAt: Date?
    var lastRunAt: Date?
    var lastOutcome: String?
    /// Oldest sample date sent so far.
    var oldestDate: Date?

    /// Read these types again from their beginning.
    mutating func forget(_ names: Set<String>) {
        for name in names {
            anchors[name] = nil
            bucketPendingFrom[name] = nil
            bucketEarliest[name] = nil
            bucketSentThrough[name] = nil
        }
        primed.subtract(names)
        completed.subtract(names)
        bucketPendingDeletes.subtract(names)
    }

    /// The Mac's store changed: start over under the new id, keep only the install id.
    mutating func reset(storeId: String?) {
        let install = installId
        self = HealthSyncSnapshot()
        self.storeId = storeId
        installId = install
    }
}

/// The one copy of `HealthSyncSnapshot`, shared by the engine (an actor, off the
/// main thread) and Disconnect (main thread), so it is lock-protected.
///
/// The file lives in Application Support with `.completeUntilFirstUserAuthentication`
/// protection (a background launch after the first unlock can still read it) and
/// is excluded from iCloud backup. Writes are coalesced to one every 2 seconds
/// plus an explicit `flush()` at the end of each run: a kill in between loses a
/// few seconds of anchors, which only means a batch is sent again, and the Mac
/// dedupes by uuid.
///
/// `generation` bumps on every erase. The engine captures it at the start of a
/// run and every commit names it, so a run that was in flight during Disconnect
/// cannot write its anchors back into the erased state.
final class HealthSyncStateStore: @unchecked Sendable {
    /// In a hosted unit-test process the app's own file is left alone: the
    /// tests run inside the installed app and must not erase its anchors.
    static let shared = HealthSyncStateStore(
        fileURL: ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil ? nil : defaultURL
    )

    private let lock = NSLock()
    private let fileURL: URL?
    private var snapshot: HealthSyncSnapshot?
    private var loadFailed = false
    private var dirty = false
    private var lastWrite = Date.distantPast
    private var generationValue = 0

    static var defaultURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("WalnutHealth", isDirectory: true)
            .appendingPathComponent("sync-state.json")
    }

    /// `fileURL` nil keeps everything in memory (tests).
    init(fileURL: URL?) {
        self.fileURL = fileURL
    }

    var generation: Int { lock.withLock { generationValue } }

    /// False when the file exists but could not be read (the phone has not been
    /// unlocked since it started). A run must not start then: it would sync from
    /// scratch and later overwrite the real anchors.
    var isReadable: Bool {
        lock.withLock {
            loadLocked()
            return !loadFailed
        }
    }

    func read() -> HealthSyncSnapshot {
        lock.withLock {
            loadLocked()
            return snapshot ?? HealthSyncSnapshot()
        }
    }

    /// Apply `body` unless the state was erased since `generation` was read.
    @discardableResult
    func update(generation expected: Int? = nil, _ body: (inout HealthSyncSnapshot) -> Void) -> Bool {
        lock.withLock {
            if let expected, expected != generationValue { return false }
            loadLocked()
            guard !loadFailed else { return false }
            var value = snapshot ?? HealthSyncSnapshot()
            body(&value)
            guard value != snapshot else { return true }
            snapshot = value
            dirty = true
            if Date().timeIntervalSince(lastWrite) >= 2 { writeLocked() }
            return true
        }
    }

    func flush() {
        lock.withLock { if dirty { writeLocked() } }
    }

    /// Disconnect and "Delete Health Data on Mac": forget everything.
    func eraseAll() {
        lock.withLock {
            generationValue += 1
            snapshot = HealthSyncSnapshot()
            loadFailed = false
            dirty = false
            if let fileURL {
                try? FileManager.default.removeItem(at: fileURL)
            }
        }
    }

    // MARK: - File

    /// A failed read is not cached: the next access tries the file again, so the
    /// first unlock after a locked background launch reads the real anchors.
    private func loadLocked() {
        guard snapshot == nil else { return }
        loadFailed = false
        guard let fileURL else {
            snapshot = HealthSyncSnapshot()
            return
        }
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            snapshot = HealthSyncSnapshot()
            return
        }
        do {
            let data = try Data(contentsOf: fileURL)
            snapshot = try JSONDecoder().decode(HealthSyncSnapshot.self, from: data)
        } catch let error as DecodingError {
            // A file this build cannot read is worth nothing: start over (the
            // Mac dedupes whatever is sent again).
            AppLog.error("health", "sync state unreadable, starting over", ["error": String(describing: type(of: error))])
            snapshot = HealthSyncSnapshot()
        } catch {
            // Protected data unavailable (before the first unlock): try again later.
            loadFailed = true
        }
    }

    private func writeLocked() {
        lastWrite = Date()
        guard let fileURL, let snapshot else {
            dirty = false
            return
        }
        do {
            let directory = fileURL.deletingLastPathComponent()
            if !FileManager.default.fileExists(atPath: directory.path) {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                var dir = directory
                try? dir.setResourceValues(values)
            }
            let data = try JSONEncoder().encode(snapshot)
            try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            dirty = false
        } catch {
            AppLog.error("health", "sync state write failed", ["error": String(describing: type(of: error))])
        }
    }
}
