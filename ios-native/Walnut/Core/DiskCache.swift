import Foundation

/// Tiny JSON file cache under Caches/ — powers stale-while-revalidate: stores
/// render cached data instantly, then refresh from the network.
enum DiskCache {
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
        DispatchQueue.global(qos: .utility).async {
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let data = try JSONEncoder().encode(value)
                try data.write(to: url(for: key), options: .atomic)
            } catch {
                // Cache writes are best-effort.
            }
        }
    }

    static func load<T: Decodable>(_ type: T.Type, key: String) -> T? {
        guard let data = try? Data(contentsOf: url(for: key)) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    static func remove(key: String) {
        try? FileManager.default.removeItem(at: url(for: key))
    }

    static func clearAll() {
        try? FileManager.default.removeItem(at: directory)
    }
}
