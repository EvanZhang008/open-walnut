import Foundation

/// The vault's ciphertext as this phone last fetched it, in the app group (so the AutoFill
/// extension reads the same copy): the header, every sealed item and its tag. Nothing in it opens
/// without the vault key, which only the Keychain holds behind Face ID.
struct VaultCacheFile: Codable, Equatable, Sendable {
    var header: VaultHeader
    var items: [String: VaultStoredItem]
    var tags: [String: String]
    var syncedAt: Date
    /// The password wrap the vault key in the Keychain was opened from: a new one (a new master
    /// password on the Mac) means that key no longer opens the items.
    var keyWrapIV: String?
}

enum VaultCache {
    static var fileURL: URL {
        VaultShared.containerURL.appendingPathComponent("Vault", isDirectory: true).appendingPathComponent("vault-cache.json")
    }

    static func load() -> VaultCacheFile? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return try? d.decode(VaultCacheFile.self, from: data)
    }

    static func save(_ file: VaultCacheFile) throws {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        let data = try e.encode(file)
        let dir = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var url = dir
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    static func delete() {
        try? FileManager.default.removeItem(at: fileURL)
    }

    /// The cache after a fetch: the new header and tags, every item whose tag changed replaced,
    /// every item the Mac no longer has removed.
    static func merged(_ old: VaultCacheFile?, header: VaultHeader, tags: [String: String], fetched: [String: VaultStoredItem], at now: Date) -> VaultCacheFile {
        var items: [String: VaultStoredItem] = [:]
        let keep = old?.header.id == header.id ? old : nil
        for (id, tag) in tags {
            if let f = fetched[id] { items[id] = f }
            else if let o = keep?.items[id], keep?.tags[id] == tag { items[id] = o }
        }
        return VaultCacheFile(header: header, items: items, tags: tags.filter { items[$0.key] != nil }, syncedAt: now, keyWrapIV: keep?.keyWrapIV)
    }

    /// The ids whose sealed copy here is missing or older than the Mac's.
    static func stale(_ old: VaultCacheFile?, header: VaultHeader, tags: [String: String]) -> [String] {
        guard let old, old.header.id == header.id else { return tags.keys.sorted() }
        return tags.compactMap { id, tag in old.tags[id] == tag && old.items[id] != nil ? nil : id }.sorted()
    }
}
