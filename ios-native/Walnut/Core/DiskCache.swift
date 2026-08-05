import Foundation

/// Tiny JSON file cache under Caches/ — powers stale-while-revalidate: stores
/// render cached data instantly, then refresh from the network.
///
/// ALL file IO runs on `ioQueue`, a reader/writer queue: reads go concurrent,
/// writes and deletes take a barrier. That ordering matters for `clearAll()` —
/// a queued `save` must not resurrect a file after a disconnect wiped the cache.
///
/// Cold-start rule (P0-1): `loadAsync` is the ONLY form callers may use on the
/// startup path. The synchronous `load` blocks its caller on
/// `Data(contentsOf:)` + a full `JSONDecoder` pass, and on the MainActor during
/// a BACKGROUND/prewarm launch that work counts against the 10s scene-update
/// allowance the OS grants before it kills the process (field crash, build 27).
enum DiskCache {
    /// Concurrent for reads, barrier for writes — see the type comment.
    private static let ioQueue = DispatchQueue(
        label: "dev.openwalnut.diskcache", qos: .utility, attributes: .concurrent
    )

    /// Count of SYNCHRONOUS loads served so far. Read by LaunchTrace to prove
    /// the first frame did not wait on any disk read; not a correctness input.
    private static let syncLoadCounter = SyncLoadCounter()

    private final class SyncLoadCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        func increment() { lock.lock(); value += 1; lock.unlock() }
        var current: Int { lock.lock(); defer { lock.unlock() }; return value }
    }

    static var synchronousLoadCount: Int { syncLoadCounter.current }

    private static var directory: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("WalnutCache", isDirectory: true)
    }

    private static func url(for key: String) -> URL {
        // Keys may contain slashes (note paths) — make them filesystem-safe.
        let safe = key.replacingOccurrences(of: "/", with: "_")
        return directory.appendingPathComponent("\(safe).json")
    }

    static func save<T: Encodable>(_ value: T, key: String) {
        // Encode on the caller's thread only if it is already off-main; the
        // barrier hop below is what serializes against clearAll().
        ioQueue.async(flags: .barrier) {
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let data = try JSONEncoder().encode(value)
                try data.write(to: url(for: key), options: .atomic)
            } catch {
                // Cache writes are best-effort.
            }
        }
    }

    /// Off-main read + decode. Use this everywhere a store hydrates.
    static func loadAsync<T: Decodable>(_ type: T.Type, key: String) async -> T? {
        await withCheckedContinuation { continuation in
            ioQueue.async {
                continuation.resume(returning: decode(type, key: key))
            }
        }
    }

    /// Synchronous read. Only for paths that are provably off the startup path
    /// and off the MainActor — prefer `loadAsync`.
    static func load<T: Decodable>(_ type: T.Type, key: String) -> T? {
        syncLoadCounter.increment()
        return decode(type, key: key)
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

    /// Wipe the whole cache (disconnect). Off-main: this is a recursive
    /// directory delete, which is real IO and used to run on the MainActor
    /// straight out of ConnectionStore.disconnect().
    static func clearAll() {
        ioQueue.async(flags: .barrier) {
            try? FileManager.default.removeItem(at: directory)
        }
    }
}
