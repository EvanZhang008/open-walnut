import Foundation
import Darwin

extension VoiceRecordingStore {
    /// Metadata evolves without making an older recording unreadable.
    struct Sidecar: Codable {
        var v: Int = 3
        var createdAt: Date
        var reason: String
        var attempts: Int = 0
        var verdicts: Int = 0
        var surface: String?
        var lastError: String?
        var lastErrorKind: String?
        var lastAttemptAt: Date?
        var transcript: String?
        var durationSeconds: Double?
        var serverID: String?
        var archiveOrigin: String?
        var archiveStorage: String?
        var archiveState: String?
        var primarySaved: Bool?
        var audioFormat: String?
        var backupError: String?

        init(createdAt: Date, reason: String) {
            self.createdAt = createdAt
            self.reason = reason
        }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            v = try c.decodeIfPresent(Int.self, forKey: .v) ?? 1
            createdAt = try c.decode(Date.self, forKey: .createdAt)
            reason = try c.decode(String.self, forKey: .reason)
            attempts = try c.decodeIfPresent(Int.self, forKey: .attempts) ?? 0
            verdicts = try c.decodeIfPresent(Int.self, forKey: .verdicts) ?? 0
            surface = try c.decodeIfPresent(String.self, forKey: .surface)
            lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
            lastErrorKind = try c.decodeIfPresent(String.self, forKey: .lastErrorKind)
            lastAttemptAt = try c.decodeIfPresent(Date.self, forKey: .lastAttemptAt)
            transcript = try c.decodeIfPresent(String.self, forKey: .transcript)
            durationSeconds = try c.decodeIfPresent(Double.self, forKey: .durationSeconds)
            serverID = try c.decodeIfPresent(String.self, forKey: .serverID)
            archiveOrigin = try c.decodeIfPresent(String.self, forKey: .archiveOrigin)
            archiveStorage = try c.decodeIfPresent(String.self, forKey: .archiveStorage)
            archiveState = try c.decodeIfPresent(String.self, forKey: .archiveState)
            primarySaved = try c.decodeIfPresent(Bool.self, forKey: .primarySaved)
            audioFormat = try c.decodeIfPresent(String.self, forKey: .audioFormat)
            backupError = try c.decodeIfPresent(String.self, forKey: .backupError)
        }
    }

    enum StoreError: LocalizedError {
        case recordingMissing, transcriptAlreadySaved, invalidDuration, emptyTranscript

        var errorDescription: String? {
            switch self {
            case .recordingMissing: return "Recording is no longer available."
            case .transcriptAlreadySaved: return "This recording already has a saved transcript."
            case .invalidDuration: return "Recording duration is invalid."
            case .emptyTranscript: return "The transcript is empty."
            }
        }
    }

    /// All read-modify-write operations share this queue, including distinct
    /// store instances pointed at the same directory. Directory scans belong
    /// on a background task: history has no automatic size limit.
    static let io = DispatchQueue(label: "walnut.voice-recordings.io", qos: .utility)

    /// Newest first, including completed recordings and transcript-only rows.
    /// Never deletes files as a side effect of reading history.
    func history() -> [Recording] {
        Self.io.sync { listUnlocked().sorted(by: Self.newestFirst) }
    }

    /// Oldest first for recovery. A completed transcript is never re-uploaded.
    func pending() -> [Recording] {
        Self.io.sync {
            listUnlocked().filter { $0.reason != "recording" && ($0.transcript == nil || $0.reason == "recovered") && $0.audioAvailable }
                .sorted { Self.newestFirst($1, $0) }
        }
    }

    /// One metadata lookup without listing an unbounded recording directory.
    func recording(id: String) -> Recording? {
        Self.io.sync { recordingUnlocked(id: id) }
    }

    /// A returned success means the transcript reached durable local storage.
    /// Audio is retained. A delayed duplicate cannot replace saved words.
    func saveTranscription(id: String, text: String) throws {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw StoreError.emptyTranscript
        }
        try update(id: id) { side in
            if let saved = side.transcript, saved != text { throw StoreError.transcriptAlreadySaved }
            side.transcript = text
            side.reason = "transcribed"
            side.lastError = nil
            side.lastErrorKind = nil
        }
    }

    func saveRecoveredTranscription(id: String, text: String) throws {
        try update(id: id) { side in
            guard side.transcript == nil else { return }
            side.transcript = text
            side.reason = "recovered"
        }
    }

    func noteDuration(id: String, duration: Double) throws {
        guard duration.isFinite, duration >= 0 else { throw StoreError.invalidDuration }
        try update(id: id) { $0.durationSeconds = duration }
    }

    /// Call only after the server acknowledged a durable recording, not after
    /// an upload was merely started. nil means primary persistence is unknown.
    func markBackup(id: String, serverID: String, primarySaved: Bool?, origin: String? = nil, storage: String? = nil) throws {
        #if DEBUG
        try _testBeforeBackupWrite?()
        #endif
        try update(id: id) { side in
            side.serverID = serverID
            if let origin { side.archiveOrigin = origin }
            if let storage { side.archiveStorage = storage }
            side.archiveState = "saved"
            side.primarySaved = primarySaved
            side.backupError = nil
        }
    }

    func clearBackup(id: String) throws {
        try update(id: id) { side in
            side.serverID = nil
            side.archiveOrigin = nil
            side.archiveStorage = nil
            side.archiveState = nil
            side.primarySaved = nil
            side.backupError = nil
        }
    }

    /// Failure diagnostics do not erase an earlier durable acknowledgement.
    func noteBackupFailure(id: String, message: String) throws {
        try update(id: id) { side in
            side.backupError = message
            if side.archiveState != "saved" { side.archiveState = "failed" }
        }
    }

    func update(id: String, _ change: (inout Sidecar) throws -> Void) throws {
        try Self.io.sync {
            let existing = try readSidecarUnlocked(id: id)
            guard existing != nil || audioURLUnlocked(id: id) != nil else { throw StoreError.recordingMissing }
            var side = existing ?? Sidecar(createdAt: recordingUnlocked(id: id)?.createdAt ?? Date(), reason: "unknown")
            try change(&side)
            side.v = 3
            side.audioFormat = audioURLUnlocked(id: id)?.pathExtension.lowercased() ?? side.audioFormat ?? "caf"
            try writeUnlocked(side, id: id)
        }
    }

    func sidecarURL(id: String) -> URL { dir.appendingPathComponent("\(id).json") }

    func audioURLUnlocked(id: String) -> URL? {
        for format in ["caf", "m4a"] {
            let url = dir.appendingPathComponent("\(id).\(format)")
            if FileManager.default.fileExists(atPath: url.path) { return url }
        }
        return nil
    }

    private static func newestFirst(_ lhs: Recording, _ rhs: Recording) -> Bool {
        lhs.createdAt == rhs.createdAt ? lhs.id > rhs.id : lhs.createdAt > rhs.createdAt
    }

    private func listUnlocked() -> [Recording] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
        let ids = Set(names.compactMap { name -> String? in
            let url = URL(fileURLWithPath: name)
            guard ["caf", "m4a", "json"].contains(url.pathExtension) else { return nil }
            return url.deletingPathExtension().lastPathComponent
        })
        return ids.compactMap { recordingUnlocked(id: $0) }
    }

    private func recordingUnlocked(id: String) -> Recording? {
        let side = try? readSidecarUnlocked(id: id)
        let audio = audioURLUnlocked(id: id)
        guard audio != nil || side != nil else { return nil }
        let url = audio ?? dir.appendingPathComponent("\(id).\(side?.audioFormat ?? "caf")")
        let attrs = audio.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path) }
        return Recording(
            id: id, audioURL: url,
            createdAt: side?.createdAt ?? (attrs?[.creationDate] as? Date) ?? Date(timeIntervalSince1970: 0),
            reason: side?.reason ?? "unknown", bytes: (attrs?[.size] as? Int) ?? 0,
            attempts: side?.attempts ?? 0, verdicts: side?.verdicts ?? 0, surface: side?.surface,
            lastError: side?.lastError,
            lastErrorKind: side?.lastErrorKind.flatMap(VoiceRetryPlan.FailureKind.init(rawValue:)),
            lastAttemptAt: side?.lastAttemptAt, transcript: side?.transcript,
            durationSeconds: side?.durationSeconds, serverID: side?.serverID,
            archiveOrigin: side?.archiveOrigin, archiveStorage: side?.archiveStorage, archiveState: side?.archiveState, primarySaved: side?.primarySaved,
            backupError: side?.backupError, audioAvailable: audio != nil
        )
    }

    func readSidecarUnlocked(id: String) throws -> Sidecar? {
        let url = sidecarURL(id: id)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(Sidecar.self, from: Data(contentsOf: url))
    }

    /// Sync the replacement before rename, then sync its directory. Errors
    /// propagate: handing words to a caller before this finishes loses them if
    /// the app crashes before its composer or message draft is persisted.
    func writeUnlocked(_ side: Sidecar, id: String) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let temporary = dir.appendingPathComponent(".\(id)-\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(at: temporary) }
        try JSONEncoder().encode(side).write(to: temporary)
        let handle = try FileHandle(forWritingTo: temporary)
        do {
            try handle.synchronize()
            try handle.close()
        } catch {
            try? handle.close()
            throw error
        }
        guard rename(temporary.path, sidecarURL(id: id).path) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        let fd = open(dir.path, O_RDONLY)
        guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        defer { close(fd) }
        guard fsync(fd) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    }
}
