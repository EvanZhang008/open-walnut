import Foundation
import Observation

/// Notes state — folder tree, pinned notes (server favorites), per-note content
/// with optimistic-locking saves, lazy row previews, and search.
@Observable
@MainActor
final class NotesStore {
    private let api = WalnutAPI()
    weak var connection: ConnectionStore?

    /// False while the app is backgrounded. EVERY async completion re-checks it
    /// before mutating observed state: a fetch that lands while suspended would
    /// otherwise drive SwiftUI updates from the background, which is exactly the
    /// scene-update work the OS kills a non-active process for (P0-3).
    private var isActive = true

    var tree: [NoteTreeNode] = []
    var loadingTree = false
    var errorMessage: String?

    /// Pinned note paths (server-side /api/favorites, shared with the web UI).
    var pinned: [String] = []

    /// Second-line metadata for note rows (modified date + content preview),
    /// fetched lazily as rows appear and cached in memory.
    struct RowMeta: Equatable {
        let preview: String
        let updatedAt: Date?
    }
    var rowMeta: [String: RowMeta] = [:]

    init() {
        LifecycleHub.shared.register(self)
    }

    /// Hydrated from the disk cache OFF-MAIN, then refreshed from the network.
    /// The cache read must never block the caller's thread: on a background /
    /// prewarm launch that read is scene-update work the OS bills against the
    /// 10s allowance before killing the process (P0-1).
    func initialize() async {
        isActive = true
        if let cached = await DiskCache.loadAsync([NoteTreeNode].self, key: "notes-tree"),
           isActive, tree.isEmpty {
            tree = cached
        }
        if let cachedPins = await DiskCache.loadAsync([String].self, key: "notes-pinned"),
           isActive, pinned.isEmpty {
            pinned = cachedPins
        }
        async let treeRefresh: Void = refreshTree()
        async let pinRefresh: Void = refreshPinned()
        _ = await (treeRefresh, pinRefresh)
    }

    func refreshTree() async {
        guard isActive else { return }
        loadingTree = true
        defer { loadingTree = false }
        do {
            let fetched = try await api.notesTree()
            guard isActive, !Task.isCancelled else { return }
            tree = fetched
            connection?.reportReachability(true, source: "notes-rest")
            DiskCache.save(tree, key: "notes-tree")
        } catch {
            if let apiError = error as? APIError, apiError.isCancelled { return }
            guard isActive else { return }
            reportIfNetwork(error)
            if tree.isEmpty { errorMessage = error.localizedDescription }
        }
    }

    // MARK: - Pinned (favorites)

    func refreshPinned() async {
        guard isActive else { return }
        do {
            let fetched = try await api.favoriteNotes()
            guard isActive, !Task.isCancelled else { return }
            pinned = fetched
            DiskCache.save(pinned, key: "notes-pinned")
        } catch {
            if let apiError = error as? APIError, apiError.isCancelled { return }
            guard isActive else { return }
            reportIfNetwork(error)
        }
    }

    func isPinned(_ path: String) -> Bool {
        pinned.contains(path)
    }

    func togglePin(_ path: String) async {
        let wasPinned = isPinned(path)
        // Optimistic flip for a snappy UI; server response is authoritative.
        if wasPinned {
            pinned.removeAll { $0 == path }
        } else {
            pinned.append(path)
        }
        do {
            let updated = wasPinned
                ? try await api.removeFavoriteNote(path: path)
                : try await api.addFavoriteNote(path: path)
            guard isActive, !Task.isCancelled else { return }
            pinned = updated
            DiskCache.save(pinned, key: "notes-pinned")
        } catch {
            if let apiError = error as? APIError, apiError.isCancelled {
                // Silent, but never leave the optimistic flip standing: no
                // authoritative answer arrived, so restore the prior state.
                if wasPinned && !pinned.contains(path) {
                    pinned.append(path)
                } else if !wasPinned {
                    pinned.removeAll { $0 == path }
                }
                return
            }
            guard isActive else { return }
            reportIfNetwork(error)
            await refreshPinned() // roll back to server truth
        }
    }

    // MARK: - Row previews (lazy)

    /// Ensure date+preview metadata for a row. Disk-cached note content is used
    /// first; otherwise fetch once. Called from row `.task` as rows appear.
    func ensureRowMeta(for path: String) async {
        guard isActive else { return }
        if rowMeta[path] != nil { return }
        if let cached = await DiskCache.loadAsync(NoteContent.self, key: "note-\(path)") {
            guard isActive else { return }
            rowMeta[path] = Self.meta(from: cached)
            return
        }
        guard let note = try? await api.noteContent(path: path) else { return }
        guard isActive, !Task.isCancelled else { return }
        DiskCache.save(note, key: "note-\(path)")
        rowMeta[path] = Self.meta(from: note)
    }

    private static func meta(from note: NoteContent) -> RowMeta {
        RowMeta(
            preview: MarkdownParser.preview(of: note.content),
            updatedAt: parseISO(note.updatedAt)
        )
    }

    static func parseISO(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    // MARK: - Search

    /// Hybrid search with a short timeout; falls back to fast string-only mode
    /// when the semantic leg stalls (cold server).
    func search(query: String, limit: Int = 30) async -> [NoteSearchResult] {
        do {
            let response = try await api.searchNotes(query: query, limit: limit, mode: "hybrid", timeout: 8)
            connection?.reportReachability(true, source: "notes-rest")
            return response.results
        } catch is CancellationError {
            return []
        } catch let error as APIError where error.isCancelled {
            return []
        } catch {
            if let fallback = try? await api.searchNotes(query: query, limit: limit, mode: "string", timeout: 8) {
                return fallback.results
            }
            reportIfNetwork(error)
            return []
        }
    }

    // MARK: - Content

    func loadNote(path: String) async throws -> NoteContent {
        do {
            let note = try await api.noteContent(path: path)
            connection?.reportReachability(true, source: "notes-rest")
            DiskCache.save(note, key: "note-\(path)")
            // Observable write only while the app is in front of the user.
            if isActive { rowMeta[path] = Self.meta(from: note) }
            return note
        } catch {
            if let apiError = error as? APIError, apiError.isCancelled { throw error }
            reportIfNetwork(error)
            // Offline fallback: serve the cached copy if we have one.
            if let cached = await DiskCache.loadAsync(NoteContent.self, key: "note-\(path)") {
                return cached
            }
            throw error
        }
    }

    enum SaveOutcome {
        case saved(NoteWriteResult)
        /// 409 — the note changed server-side; caller decides overwrite vs reload.
        case conflict(serverHash: String?, serverContent: String?)
    }

    func save(path: String, content: String, expectedHash: String?) async throws -> SaveOutcome {
        do {
            let result = try await api.saveNote(path: path, content: content, expectedHash: expectedHash)
            let note = NoteContent(content: content, contentHash: result.contentHash, updatedAt: result.updatedAt)
            DiskCache.save(note, key: "note-\(path)")
            // A backgrounded save still persists (the user's text must land) —
            // only the observable row-preview write waits for foreground.
            if isActive { rowMeta[path] = Self.meta(from: note) }
            return .saved(result)
        } catch let error as APIError where error.isConflict {
            if case .server(_, _, _, let serverHash, let serverContent) = error {
                return .conflict(serverHash: serverHash, serverContent: serverContent)
            }
            return .conflict(serverHash: nil, serverContent: nil)
        } catch {
            if let apiError = error as? APIError, apiError.isCancelled { throw error }
            reportIfNetwork(error)
            throw error
        }
    }

    /// Create a note; returns the created path (server may normalize).
    @discardableResult
    func create(path: String) async -> Bool {
        do {
            _ = try await api.createNote(path: path)
            await refreshTree()
            return true
        } catch let error as APIError where error.isConflict {
            if isActive { errorMessage = "A note with that name already exists." }
            return false
        } catch {
            if let apiError = error as? APIError, apiError.isCancelled { return false }
            guard isActive else { return false }
            reportIfNetwork(error)
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func remove(path: String) async -> Bool {
        do {
            try await api.deleteNote(path: path)
            if isPinned(path) { await togglePin(path) }
            if isActive { rowMeta[path] = nil }
            await refreshTree()
            return true
        } catch {
            if let apiError = error as? APIError, apiError.isCancelled { return false }
            guard isActive else { return false }
            reportIfNetwork(error)
            errorMessage = error.localizedDescription
            return false
        }
    }

    // MARK: - Tree helpers

    /// Children of a folder path ("" = root), or nil when the folder vanished.
    func children(of folderPath: String) -> [NoteTreeNode]? {
        if folderPath.isEmpty { return tree }
        func find(_ nodes: [NoteTreeNode]) -> [NoteTreeNode]? {
            for node in nodes where node.type == .folder {
                if node.path == folderPath { return node.children ?? [] }
                if folderPath.hasPrefix(node.path + "/"), let found = find(node.children ?? []) {
                    return found
                }
            }
            return nil
        }
        return find(tree)
    }

    /// Recursive note count (attachments excluded) — folder row badges.
    static func noteCount(in node: NoteTreeNode) -> Int {
        guard node.type == .folder else { return 0 }
        var count = 0
        for child in node.children ?? [] {
            if child.type == .file {
                if !child.isAttachment { count += 1 }
            } else {
                count += noteCount(in: child)
            }
        }
        return count
    }

    private func reportIfNetwork(_ error: Error) {
        if let apiError = error as? APIError {
            if apiError.isCancelled { return }
            if case .network = apiError {
                connection?.reportReachability(false, source: "notes-rest", error: error)
            }
        }
    }
}

extension NotesStore: LifecycleSuspendable {
    /// No streams or timers to tear down here — the quiescence contract is
    /// purely "stop mutating observed state" (see `isActive`). In-flight
    /// requests settle and their completions become no-ops.
    func suspendForBackground() { isActive = false }
    func resumeForForeground() { isActive = true }
}
