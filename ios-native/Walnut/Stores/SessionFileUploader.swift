import Foundation
import UIKit

/// Moves one attached file to the session's host, chunk by chunk
/// (`PUT /api/v1/sessions/:id/uploads/:uploadId`), and answers the path it got.
///
/// Resumable by construction: every reply names how many bytes the host holds,
/// and the next chunk starts there. A chunk whose answer was lost is sent again
/// and acknowledged without a second write; a 409 says where the host really is;
/// a 422 (the host's copy differs) starts over once. A short outage is ridden out
/// here (three tries per chunk); a longer one is thrown, and the bubble's own
/// retry ladder (`SessionConversationStore.deliver`) calls back in with the
/// offset this run reached, so a retry never sends the bytes already there.
enum SessionFileUploader {
    /// The server's chunk size (session-uploads.ts UPLOAD_CHUNK_BYTES).
    static let chunkBytes = 2 * 1024 * 1024
    /// Tries per chunk for an answer that clears on its own (no answer, bridge
    /// offline, a 502 or 504 from a hop) before the ladder takes over.
    static let triesPerChunk = 3

    enum UploadError: LocalizedError {
        case checksumMismatch
        case stalled
        /// The server has no uploads route (an older Walnut): its plain 404.
        case serverTooOld
        /// The app's copy of the file is gone (storage was cleared).
        case fileGone(String)
        var errorDescription: String? {
            switch self {
            case .fileGone(let name): return "\(name) is no longer on this phone. Delete this message, then attach the file again."
            case .serverTooOld: return "Your Walnut server is too old to take files. Update Walnut on your Mac, then tap the message to send it again."
            case .checksumMismatch: return "The file arrived different from what was sent, twice. Try sending it again."
            case .stalled: return "The file upload stopped moving. Try sending it again."
            }
        }
    }

    /// Upload `file` from `start`. `onProgress` gets the bytes the host holds after
    /// each chunk. Returns the file's path on the session's host.
    static func upload(
        _ file: ComposerFile, sessionID: String, transport: SessionUploadTransport,
        from start: Int64 = 0, pauseBetweenTries: Duration = .seconds(1),
        onProgress: @MainActor @escaping (Int64) -> Void
    ) async throws -> String {
        let handle = try FileHandle(forReadingFrom: file.localURL)
        defer { try? handle.close() }
        var offset = min(max(0, start), file.size)
        var restarts = 0
        var standing = 0
        while true {
            try Task.checkCancellation()
            let length = Int(min(Int64(chunkBytes), file.size - offset))
            let at = offset
            let data = try await Task.detached(priority: .utility) { () throws -> Data in
                try handle.seek(toOffset: UInt64(at))
                return try handle.read(upToCount: length) ?? Data()
            }.value
            // The last chunk carries the checksum: the host checks the whole file
            // with it, and a repeat of it after the rename is recognised by it.
            let isLast = offset + Int64(data.count) >= file.size
            let outcome = try await sendChunk(file, sessionID: sessionID, transport: transport, offset: offset,
                                              data: data, sha256: isLast ? file.sha256 : nil, pause: pauseBetweenTries)
            let before = offset
            switch outcome {
            case .reply(let reply):
                if reply.done {
                    guard let path = reply.path, !path.isEmpty else { throw APIError.badResponse }
                    await onProgress(file.size)
                    return path
                }
                offset = min(max(0, reply.received), file.size)
            case .resumeAt(let held):
                offset = min(max(0, held), file.size)
            case .restart:
                restarts += 1
                if restarts > 1 { throw UploadError.checksumMismatch }
                offset = 0
            }
            await onProgress(offset)
            // A host that keeps answering the same place is not getting anywhere.
            standing = offset > before ? 0 : standing + 1
            if standing > 4 { throw UploadError.stalled }
        }
    }

    /// The host holds all of `file` but the app's copy is gone: the empty last
    /// chunk, with the checksum, gets the path of the finished upload.
    static func finish(_ file: ComposerFile, sessionID: String, transport: SessionUploadTransport) async throws -> String {
        let outcome = try await sendChunk(file, sessionID: sessionID, transport: transport, offset: file.size,
                                          data: Data(), sha256: file.sha256, pause: .seconds(1))
        guard case .reply(let reply) = outcome, reply.done, let path = reply.path, !path.isEmpty else {
            throw UploadError.fileGone(file.name)
        }
        return path
    }

    private static func sendChunk(
        _ file: ComposerFile, sessionID: String, transport: SessionUploadTransport,
        offset: Int64, data: Data, sha256: String?, pause: Duration
    ) async throws -> UploadChunkOutcome {
        var attempt = 0
        while true {
            do {
                return try await transport.uploadChunk(
                    sessionID: sessionID, uploadID: file.id, name: file.name, size: file.size,
                    offset: offset, sha256: sha256, data: data)
            } catch let error as APIError where isMissingRoute(error) {
                throw UploadError.serverTooOld
            } catch {
                attempt += 1
                guard attempt < triesPerChunk, clearsOnItsOwn(error), !Task.isCancelled else { throw error }
                try await Task.sleep(for: pause * attempt)
            }
        }
    }

    /// An older server's own 404 for a route it does not have: a plain
    /// `{"error":"Not found: PUT …"}`, which reads as `http_error`. Every 404 the
    /// uploads route itself answers carries a code (`not_found`).
    static func isMissingRoute(_ error: APIError) -> Bool {
        if case .server(404, "http_error", _, _, _) = error { return true }
        return false
    }

    /// The answers a chunk retry can fix: no answer, the bridge down, a hop's 502/504.
    static func clearsOnItsOwn(_ error: Error) -> Bool {
        if SendRetryPolicy.isRetryable(error) { return true }
        if case .server(let status, let code, _, _, _) = error as? APIError {
            return status == 504 || (status == 502 && code == "upload_failed") || code == "primary_timeout"
        }
        return false
    }

    /// Ask iOS for time to finish when the app goes to the background mid-upload,
    /// ended when the work ends or the time runs out (never left open: iOS ends an
    /// app that keeps an expired assertion).
    @MainActor
    static func withBackgroundTime<T>(_ name: String, _ work: () async throws -> T) async rethrows -> T {
        var id = UIBackgroundTaskIdentifier.invalid
        id = UIApplication.shared.beginBackgroundTask(withName: name) {
            UIApplication.shared.endBackgroundTask(id)
            id = .invalid
        }
        defer {
            if id != .invalid { UIApplication.shared.endBackgroundTask(id) }
        }
        return try await work()
    }
}
