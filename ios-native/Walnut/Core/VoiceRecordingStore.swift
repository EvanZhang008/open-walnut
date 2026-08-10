import Foundation

/// Durable store for voice recordings — the backbone of "voice input never
/// loses the user's words" (field incident 2026-08-09: a long dictation
/// vanished when the phone auto-locked; the recorder recorded into tmp/ and
/// deleted the file on every non-success path).
///
/// Contract:
///  - Recordings are written straight into Application Support (never tmp/,
///    which iOS purges) as `<id>.m4a` + a `<id>.json` sidecar.
///  - The sidecar is written when recording STARTS, so a crash mid-recording
///    still leaves a discoverable orphan for next-launch recovery.
///  - Audio is deleted ONLY after transcription succeeded and the text was
///    handed to the composer — or by explicit user discard / age-out pruning.
///
/// Not @MainActor: all operations are small synchronous file ops on a ~20-file
/// directory; callers off the main actor (tests, detached tasks) use it too.
struct VoiceRecordingStore {
    struct Recording: Identifiable, Equatable {
        let id: String
        let audioURL: URL
        let createdAt: Date
        /// Why it's still here: "recording" (in flight / crashed mid-take),
        /// "interrupted", "transcribe-failed", "view-dismissed", "background".
        let reason: String
        let bytes: Int
    }

    /// Sidecar payload — versioned so future fields stay decodable.
    private struct Sidecar: Codable {
        var v: Int = 1
        var createdAt: Date
        var reason: String
    }

    static let shared = VoiceRecordingStore()

    /// Age-out: recordings older than this are pruned (the user has moved on).
    static let maxAge: TimeInterval = 7 * 24 * 3600
    /// Count cap so disk use stays bounded even under repeated failures.
    static let maxCount = 20

    private let dir: URL

    /// `baseDir` injection is the test seam — unit tests run against a temp
    /// directory, production uses Application Support (persistent, backed up,
    /// never purged under storage pressure unlike tmp/ and Caches/).
    init(baseDir: URL? = nil) {
        if let baseDir {
            dir = baseDir
        } else {
            let support = FileManager.default.urls(
                for: .applicationSupportDirectory, in: .userDomainMask
            )[0]
            dir = support.appendingPathComponent("voice-recordings", isDirectory: true)
        }
    }

    /// Where a new take records to. Creates the directory on first use.
    func newRecordingURL(id: String = UUID().uuidString) -> URL {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("\(id).m4a")
    }

    /// Write/overwrite the sidecar. Called at recording start (crash safety)
    /// and again on failure paths with a more specific reason.
    func preserve(id: String, reason: String, createdAt: Date = Date()) {
        // Keep the original createdAt when re-marking an existing recording —
        // age-based pruning must count from the take, not the last failure.
        let existing = readSidecar(id: id)
        let sidecar = Sidecar(createdAt: existing?.createdAt ?? createdAt, reason: reason)
        guard let data = try? JSONEncoder().encode(sidecar) else { return }
        try? data.write(to: sidecarURL(id: id), options: .atomic)
    }

    /// All recoverable recordings, oldest first (retry replays them in the
    /// order they were spoken). A sidecar without audio is cleaned up; audio
    /// without a sidecar (pre-fix stragglers) is still listed with epoch-of-
    /// file as createdAt so nothing silently falls off the recovery surface.
    func pending() -> [Recording] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return [] }
        var out: [Recording] = []
        for name in names where name.hasSuffix(".m4a") {
            let id = String(name.dropLast(4))
            let audio = dir.appendingPathComponent(name)
            let attrs = try? fm.attributesOfItem(atPath: audio.path)
            let bytes = (attrs?[.size] as? Int) ?? 0
            let side = readSidecar(id: id)
            let created = side?.createdAt
                ?? (attrs?[.creationDate] as? Date)
                ?? Date(timeIntervalSince1970: 0)
            out.append(Recording(
                id: id, audioURL: audio, createdAt: created,
                reason: side?.reason ?? "unknown", bytes: bytes
            ))
        }
        // Orphaned sidecars (audio gone) serve no one — sweep them here.
        for name in names where name.hasSuffix(".json") {
            let id = String(name.dropLast(5))
            if !names.contains("\(id).m4a") {
                try? fm.removeItem(at: sidecarURL(id: id))
            }
        }
        return out.sorted { $0.createdAt < $1.createdAt }
    }

    /// Transcription succeeded and the text reached the composer — the ONLY
    /// success path that deletes audio.
    func markTranscribed(id: String) {
        discard(id: id)
    }

    /// Explicit removal (user cancel, success, prune).
    func discard(id: String) {
        try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(id).m4a"))
        try? FileManager.default.removeItem(at: sidecarURL(id: id))
    }

    /// Bound disk usage: drop takes past `maxAge`, then oldest beyond
    /// `maxCount`. Returns how many were removed (logged by the caller).
    @discardableResult
    func prune(now: Date = Date()) -> Int {
        var removed = 0
        var kept: [Recording] = []
        for rec in pending() {
            if now.timeIntervalSince(rec.createdAt) > Self.maxAge {
                discard(id: rec.id)
                removed += 1
            } else {
                kept.append(rec)
            }
        }
        if kept.count > Self.maxCount {
            for rec in kept.prefix(kept.count - Self.maxCount) {
                discard(id: rec.id)
                removed += 1
            }
        }
        return removed
    }

    // MARK: - Internals

    private func sidecarURL(id: String) -> URL {
        dir.appendingPathComponent("\(id).json")
    }

    private func readSidecar(id: String) -> Sidecar? {
        guard let data = try? Data(contentsOf: sidecarURL(id: id)) else { return nil }
        return try? JSONDecoder().decode(Sidecar.self, from: data)
    }
}
