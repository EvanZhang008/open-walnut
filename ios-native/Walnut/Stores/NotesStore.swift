import Foundation
import Observation

/// Notes state — folder tree + per-note content with optimistic-locking saves
/// (PUT with expectedHash; 409 surfaces a "server changed" choice to the user).
@Observable
@MainActor
final class NotesStore {
    private let api = WalnutAPI()
    weak var connection: ConnectionStore?

    var tree: [NoteTreeNode] = []
    var loadingTree = false
    var errorMessage: String?

    /// Loaded from disk cache instantly; refreshed from the network after.
    func initialize() async {
        if let cached: [NoteTreeNode] = DiskCache.load([NoteTreeNode].self, key: "notes-tree") {
            tree = cached
        }
        await refreshTree()
    }

    func refreshTree() async {
        loadingTree = true
        defer { loadingTree = false }
        do {
            tree = try await api.notesTree()
            connection?.reportReachability(true)
            DiskCache.save(tree, key: "notes-tree")
        } catch {
            reportIfNetwork(error)
            if tree.isEmpty { errorMessage = error.localizedDescription }
        }
    }

    func loadNote(path: String) async throws -> NoteContent {
        do {
            let note = try await api.noteContent(path: path)
            connection?.reportReachability(true)
            DiskCache.save(note, key: "note-\(path)")
            return note
        } catch {
            reportIfNetwork(error)
            // Offline fallback: serve the cached copy if we have one.
            if let cached: NoteContent = DiskCache.load(NoteContent.self, key: "note-\(path)") {
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
            DiskCache.save(
                NoteContent(content: content, contentHash: result.contentHash, updatedAt: result.updatedAt),
                key: "note-\(path)"
            )
            return .saved(result)
        } catch let error as APIError where error.isConflict {
            if case .server(_, _, _, let serverHash, let serverContent) = error {
                return .conflict(serverHash: serverHash, serverContent: serverContent)
            }
            return .conflict(serverHash: nil, serverContent: nil)
        } catch {
            reportIfNetwork(error)
            throw error
        }
    }

    @discardableResult
    func create(path: String) async -> Bool {
        do {
            _ = try await api.createNote(path: path)
            await refreshTree()
            return true
        } catch let error as APIError where error.isConflict {
            errorMessage = "A note with that name already exists."
            return false
        } catch {
            reportIfNetwork(error)
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func remove(path: String) async -> Bool {
        do {
            try await api.deleteNote(path: path)
            await refreshTree()
            return true
        } catch {
            reportIfNetwork(error)
            errorMessage = error.localizedDescription
            return false
        }
    }

    private func reportIfNetwork(_ error: Error) {
        if let apiError = error as? APIError, case .network = apiError {
            connection?.reportReachability(false)
        }
    }
}
