import Foundation

/// File sends and their uploads in flight in this process, shared by every store.
///
/// Leaving a session page and opening it again builds a new store while the old
/// one is still delivering (a page that went away does not stop a send). When each
/// store kept its own uploads and attempts, the new one uploaded the same files
/// again and POSTed the message a second time, and the server takes a repeat of a
/// message id once only while the first is still queued. Here each file uploads
/// once and anyone who needs its path joins that upload, and a store that finds
/// another store's attempt for the same bubble waits for that attempt's outcome
/// instead of sending.
@MainActor
enum FileSendFlights {
    private static var uploads: [String: Task<String, Error>] = [:]
    private static var paths: [String: String] = [:]
    /// Who draws each file's progress, one key per delivery attempt.
    private static var watchers: [String: [UUID: (Int64) -> Void]] = [:]

    private struct Attempt {
        let owner: ObjectIdentifier
        var count: Int
        var accepted: Bool
        var waiters: [CheckedContinuation<Bool, Never>]
    }
    private static var attempts: [String: Attempt] = [:]
    /// Bubbles the server took in this run of the app.
    private static var accepted: Set<String> = []

    // MARK: Uploads

    /// The file's path on the host: known, joined while its upload runs, or
    /// uploaded now from `start`.
    static func path(
        for file: ComposerFile, sessionID: String, transport: SessionUploadTransport, from start: Int64
    ) async throws -> String {
        if let path = paths[file.id] { return path }
        if let running = uploads[file.id] { return try await running.value }
        let id = file.id
        let task = Task { @MainActor () throws -> String in
            try await SessionFileUploader.upload(file, sessionID: sessionID, transport: transport, from: start) { held in
                for watcher in (watchers[id] ?? [:]).values { watcher(held) }
            }
        }
        uploads[id] = task
        do {
            let path = try await task.value
            if uploads[id] == task { uploads[id] = nil; paths[id] = path }
            return path
        } catch {
            if uploads[id] == task { uploads[id] = nil }
            throw error
        }
    }

    /// `onHeld` hears the bytes the host holds of `fileID` until `unwatch`.
    static func watch(_ fileID: String, by owner: UUID, _ onHeld: @escaping (Int64) -> Void) {
        watchers[fileID, default: [:]][owner] = onHeld
    }

    static func unwatch(_ fileID: String, by owner: UUID) {
        watchers[fileID]?[owner] = nil
        if watchers[fileID]?.isEmpty == true { watchers[fileID] = nil }
    }

    static func knownPath(_ fileID: String) -> String? { paths[fileID] }

    /// The app's copy is going: its upload stops and its path is forgotten.
    static func forget(_ fileID: String) {
        uploads[fileID]?.cancel()
        uploads[fileID] = nil
        paths[fileID] = nil
    }

    // MARK: Attempts

    /// Starts an attempt to send `bubble`, unless another store's attempt runs
    /// (then await `outcome(of:)`). One store may run several (a manual retry
    /// over an automatic one); its own `deliveryOwners` sorts those out.
    static func begin(_ bubble: String, owner: ObjectIdentifier) -> Bool {
        if var running = attempts[bubble] {
            guard running.owner == owner else { return false }
            running.count += 1
            attempts[bubble] = running
            return true
        }
        attempts[bubble] = Attempt(owner: owner, count: 1, accepted: false, waiters: [])
        return true
    }

    static func end(_ bubble: String, owner: ObjectIdentifier, accepted ok: Bool) {
        guard var running = attempts[bubble], running.owner == owner else { return }
        running.count -= 1
        running.accepted = running.accepted || ok
        if ok { accepted.insert(bubble) }
        guard running.count == 0 else { attempts[bubble] = running; return }
        attempts[bubble] = nil
        for waiter in running.waiters { waiter.resume(returning: running.accepted) }
    }

    /// Whether the attempts running for `bubble` got it accepted (at once when
    /// none runs: whether one did earlier in this run of the app).
    static func outcome(of bubble: String) async -> Bool {
        guard attempts[bubble] != nil else { return accepted.contains(bubble) }
        return await withCheckedContinuation { waiter in attempts[bubble]?.waiters.append(waiter) }
    }

    static func wasAccepted(_ bubble: String) -> Bool { accepted.contains(bubble) }
}
