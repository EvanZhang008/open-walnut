import Foundation

/// On-disk store for state the user COMMITTED, as opposed to state the app can
/// fetch again.
///
/// WHY THIS IS NOT `DiskCache`. That one lives under `Caches/`, which is exactly
/// right for what it holds: a conversation list, a page of messages, a launch
/// options payload. iOS may purge `Caches/` under disk pressure and
/// `DiskCache.clearAll()` deletes the whole directory on a disconnect, and both
/// are harmless there because every one of those files can be re-read from the
/// server.
///
/// A banked send cannot. It is a sentence the user typed and asked us to deliver,
/// and it exists in exactly one place until it reaches the server: here. A purge
/// or a `clearAll()` would be silent data loss, so this store has its own root
/// under Application Support and NOTHING wipes it wholesale — entries are removed
/// one at a time, by the code that knows they were delivered.
///
/// Same IO discipline as `DiskCache` (one reader/writer queue, barrier writes,
/// atomic replace) so a save can never interleave with the read that restores it.
enum DurableStore {
    private static let ioQueue = DispatchQueue(
        label: "dev.openwalnut.durablestore", qos: .utility, attributes: .concurrent
    )

    /// Application Support, NOT Caches. Created on demand; `isExcludedFromBackup`
    /// is deliberately NOT set, because a restored backup carrying an undelivered
    /// message is the outcome the user would want.
    private static var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("WalnutDurable", isDirectory: true)
    }

    private static func url(for key: String) -> URL {
        let safe = key.replacingOccurrences(of: "/", with: "_")
        return directory.appendingPathComponent("\(safe).json")
    }

    /// Write, and report whether the bytes really landed.
    ///
    /// SYNCHRONOUS, unlike `DiskCache.save`. A caller here is persisting something
    /// it is about to stop holding anywhere else, so "did this land" is the whole
    /// question and a fire-and-forget barrier hop cannot answer it.
    @discardableResult
    static func save<T: Encodable>(_ value: T, key: String) -> Bool {
        ioQueue.sync(flags: .barrier) {
            do {
                try FileManager.default.createDirectory(
                    at: directory, withIntermediateDirectories: true
                )
                let data = try JSONEncoder().encode(value)
                try data.write(to: url(for: key), options: .atomic)
                return true
            } catch {
                AppLog.error("store", "durable write failed", [
                    "key": key, "error": String(describing: error),
                ])
                return false
            }
        }
    }

    static func loadAsync<T: Decodable>(_ type: T.Type, key: String) async -> T? {
        await withCheckedContinuation { continuation in
            ioQueue.async {
                continuation.resume(returning: decode(type, key: key))
            }
        }
    }

    private static func decode<T: Decodable>(_ type: T.Type, key: String) -> T? {
        guard let data = try? Data(contentsOf: url(for: key)) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    static func remove(key: String) {
        ioQueue.async(flags: .barrier) {
            try? FileManager.default.removeItem(at: url(for: key))
        }
    }

    /// Keys currently on disk under `prefix`. The only reason this exists is
    /// ORPHAN SWEEPING: a process killed between writing a payload file and
    /// writing the index that references it leaves a file nothing will ever read,
    /// and a store that cannot enumerate itself can never notice.
    static func keys(withPrefix prefix: String) -> [String] {
        ioQueue.sync {
            let names = (try? FileManager.default.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: nil
            )) ?? []
            return names
                .filter { $0.pathExtension == "json" }
                .map { $0.deletingPathExtension().lastPathComponent }
                .filter { $0.hasPrefix(prefix) }
        }
    }

    #if DEBUG
    /// Tests only: forget everything. Production has no such path on purpose —
    /// see the type comment.
    static func removeAllForTesting() {
        ioQueue.sync(flags: .barrier) {
            try? FileManager.default.removeItem(at: directory)
        }
    }
    #endif
}
