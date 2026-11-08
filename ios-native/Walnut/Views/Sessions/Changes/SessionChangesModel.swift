import CryptoKit
import Foundation
import Observation

/// What the Changed page last read, kept on disk so it opens offline.
struct CachedChanges: Codable {
    let savedAt: Date
    let response: SessionChangesResponse
}

/// One file's content as last read, kept on disk so an opened diff reads offline.
struct CachedFileChange: Codable {
    let savedAt: Date
    let file: SessionChangedFile
}

/// The Changed page's data: the list for the chosen comparison and each file's
/// content, from the server when it answers and from this phone's copy when it
/// does not (the page then says how old the copy is).
@MainActor
@Observable
final class SessionChangesModel {
    let sessionId: String
    private let api = WalnutAPI()

    private(set) var compare: DiffCompare
    private(set) var list: SessionChangesResponse?
    /// When the list on screen was read; set only while it is this phone's copy.
    private(set) var offlineCopyFrom: Date?
    private(set) var loading = false
    private(set) var loadError: String?
    private(set) var refs: SessionGitRefs?
    private(set) var refsError: String?

    /// Content read this visit, by file path (the list's comparison only).
    private var contents: [String: SessionChangedFile] = [:]
    private var loadGeneration = 0
    /// The saved diffs were trimmed for this page (once: a trim lists the whole cache).
    private var trimmedCache = false

    static func compareKey(_ sessionId: String) -> String { "changes.compare.\(sessionId)" }
    /// Every saved diff starts with this; together they stay under
    /// `cacheMaxBytes` (each file opened in each comparison adds one). The few
    /// lists, and the comparison picked per session, are not trimmed.
    static let cachePrefix = "changes.file."
    static let cacheMaxBytes = 50 << 20

    static func listKey(_ sessionId: String, _ compare: DiffCompare) -> String {
        "changes.list.\(sessionId).\(digest(compare.cacheKey))"
    }
    static func fileKey(_ sessionId: String, _ compare: DiffCompare, _ path: String) -> String {
        "changes.file.\(sessionId).\(digest(compare.cacheKey + "\u{1}" + path))"
    }

    /// A short stable name for a cache file (paths and refs hold any character).
    static func digest(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).prefix(10).map { String(format: "%02x", $0) }.joined()
    }

    init(sessionId: String) {
        self.sessionId = sessionId
        compare = UserDefaults.standard.data(forKey: Self.compareKey(sessionId))
            .flatMap { try? JSONDecoder().decode(DiffCompare.self, from: $0) } ?? .session
    }

    var files: [SessionChangedFile] { list?.files ?? [] }

    var totals: (additions: Int, deletions: Int, counted: Bool) {
        var add = 0, del = 0, counted = false
        for f in files {
            if let a = f.additions { add += a; counted = true }
            if let d = f.deletions { del += d; counted = true }
        }
        return (add, del, counted)
    }

    func repoRoot(of file: SessionChangedFile) -> String? {
        list?.groups.first { $0.files.contains { $0.filePath == file.filePath } }?.repoRoot
    }

    /// The default branch's name, from the list's answer or the picker's lists.
    var defaultRef: String? {
        if let ref = refs?.defaultRef, !ref.isEmpty { return ref }
        return list?.groups.lazy.compactMap { $0.compare?.ref }.first
    }

    func setCompare(_ next: DiffCompare) async {
        guard next != compare else { return }
        compare = next
        if let data = try? JSONEncoder().encode(next) {
            UserDefaults.standard.set(data, forKey: Self.compareKey(sessionId))
        }
        list = nil
        contents = [:]
        await load()
    }

    /// The list: this phone's copy at once, then the server's.
    func load(refresh: Bool = false) async {
        loadGeneration += 1
        let generation = loadGeneration
        let compare = self.compare
        loadError = nil
        // Pulled to refresh: every diff is read again too.
        if refresh { contents = [:] }
        if list == nil, let cached = await DiskCache.loadAsync(CachedChanges.self, key: Self.listKey(sessionId, compare)),
           generation == loadGeneration {
            list = cached.response
            offlineCopyFrom = cached.savedAt
        }
        loading = true
        defer { if generation == loadGeneration { loading = false } }
        var attempt = 0
        var refreshNext = refresh
        while true {
            do {
                let answer = try await api.sessionChanges(id: sessionId, compare: compare, refresh: refreshNext)
                guard generation == loadGeneration else { return }
                refreshNext = false
                apply(answer, compare: compare)
                // A copy the server is still recomputing: ask again shortly.
                guard answer.stale == true, attempt < 20 else { return }
                attempt += 1
                try? await Task.sleep(for: .milliseconds([500, 1000, 2000][min(attempt - 1, 2)]))
                guard !Task.isCancelled, generation == loadGeneration else { return }
            } catch {
                guard generation == loadGeneration else { return }
                if (error as? APIError)?.isCancelled == true { return }
                if list == nil {
                    loadError = error.localizedDescription
                } else if offlineCopyFrom == nil {
                    // A list read this visit stays; the page says it could not refresh.
                    loadError = error.localizedDescription
                }
                return
            }
        }
    }

    private func apply(_ answer: SessionChangesResponse, compare: DiffCompare) {
        let changed = list != answer
        list = answer
        offlineCopyFrom = nil
        loadError = nil
        if changed {
            // The list moved on: a file's content read for the old list may be outdated.
            contents = contents.filter { path, kept in
                answer.files.contains { $0.filePath == path && $0.status == kept.status
                    && $0.additions == kept.additions && $0.deletions == kept.deletions }
            }
        }
        DiskCache.save(CachedChanges(savedAt: Date(), response: answer), key: Self.listKey(sessionId, compare))
    }

    /// This phone's saved copy of a file for the current comparison, shown at
    /// once while the server is asked: a server that hangs must not keep a diff
    /// read before off the screen.
    func savedCopy(of file: SessionChangedFile) async -> (file: SessionChangedFile, savedAt: Date)? {
        let compare = self.compare
        guard contents[file.filePath] == nil,
              let cached = await DiskCache.loadAsync(CachedFileChange.self, key: Self.fileKey(sessionId, compare, file.filePath)),
              compare == self.compare else { return nil }
        return (cached.file, cached.savedAt)
    }

    /// A file with its before/after. `fromCopy` = this phone's saved copy (the
    /// server did not answer). `refresh` (Reload) asks the server again even
    /// when this visit already read it.
    func content(of file: SessionChangedFile, refresh: Bool = false) async throws -> (file: SessionChangedFile, fromCopy: Date?) {
        let compare = self.compare
        if !refresh, let kept = contents[file.filePath] { return (kept, nil) }
        // Reload: the list is read again first, with refresh, so the server (and the
        // host's daemon) work out the changes anew; a file read alone is served
        // from their caches and would bring the old text back.
        if refresh { await load(refresh: true) }
        let listed = files.first { $0.filePath == file.filePath } ?? file
        do {
            let answer = try await api.sessionFileChange(
                id: sessionId, path: file.filePath, compare: compare, repoRoot: repoRoot(of: listed))
            let full = listed.withContent(before: answer.file.before, after: answer.file.after, partial: answer.file.partial)
            if compare == self.compare { contents[file.filePath] = full }
            DiskCache.save(CachedFileChange(savedAt: Date(), file: full), key: Self.fileKey(sessionId, compare, file.filePath))
            if !trimmedCache {
                trimmedCache = true
                DiskCache.trim(prefix: Self.cachePrefix, maxBytes: Self.cacheMaxBytes)
            }
            return (full, nil)
        } catch {
            if (error as? APIError)?.isCancelled == true { throw error }
            if let cached = await DiskCache.loadAsync(CachedFileChange.self, key: Self.fileKey(sessionId, compare, file.filePath)) {
                return (cached.file, cached.savedAt)
            }
            throw error
        }
    }

    /// Where the page should open a diff at: set by the review, taken by the diff.
    var focus: (filePath: String, lineKey: String)?

    func loadRefs() async {
        refsError = nil
        do {
            refs = try await api.sessionGitRefs(id: sessionId)
        } catch {
            if (error as? APIError)?.isCancelled == true { return }
            refsError = error.localizedDescription
        }
    }
}
