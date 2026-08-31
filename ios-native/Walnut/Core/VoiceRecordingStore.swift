import Foundation
import os

/// Retry decisions for preserved voice takes — the pure core of the drain.
///
/// Extracted out of `VoiceRecorder` (which cannot be instantiated in a unit test
/// without an AVAudioSession) so the rules that actually carried the 2026-08-30
/// defect are provable: the banner "1 recording saved — transcription pending"
/// could never clear. Two independent reasons, both fixed here.
///  - The drain stopped at the FIRST failure, so one unreadable take blocked
///    every good recording behind it for the whole 7-day retention window.
///  - A take the engine answered with EMPTY text was preserved and marked
///    failed, and retrying the same bytes produced the same empty answer
///    forever. Nothing in the model could ever say "this one is done".
enum VoiceRetryPlan {
    /// Why the last attempt on a take failed. The distinction that matters is
    /// not severity, it is DETERMINISM: whether retrying the same bytes through
    /// the same engine could plausibly answer differently.
    enum FailureKind: String, Equatable {
        /// The server answered 200 and heard no words.
        case empty
        /// The server refused this audio outright (4xx — bad format, too big).
        case rejected
        /// The server INSPECTED the file and reported it undecodable
        /// (`422 bad_audio`): an m4a whose recording was killed before the `moov`
        /// atom was written. Its own class, and the only one that is final on the
        /// FIRST answer, because it is not an opinion that another engine could
        /// hold differently — the container is incomplete. Retrying it is a
        /// guaranteed-identical round trip on cellular data.
        case damaged
        /// Offline, timeout, 5xx — the audio never got a fair reading.
        case transport
        /// Our own upload task was torn down mid-flight (lifecycle, teardown).
        case cancelled

        /// Does a repeat of this failure prove something about the AUDIO?
        ///
        /// This is what makes retiring a stuck take safe. An
        /// `empty`/`rejected`/`damaged` verdict is a property of the recording, so
        /// another identical answer is the last word. A `transport`/`cancelled`
        /// failure says nothing about the recording at all and must never count
        /// against it — otherwise a sleeping Mac would "prove" a perfect dictation
        /// untranscribable in two taps and offer the user only a trash can.
        var isDeterministic: Bool {
            switch self {
            case .empty, .rejected, .damaged: return true
            case .transport, .cancelled: return false
            }
        }

        /// Is ONE of these answers already the last word?
        ///
        /// Only `damaged`. `empty` deserves a second look because the engine can
        /// genuinely change between attempts (the Mac reconnects and a local model
        /// answers instead of the cloud fallback, and it may hear the speech the
        /// first one missed); `rejected` covers caps and validation that a server
        /// update can move. "This container is truncated" moves for nobody.
        var isFinalOnFirstVerdict: Bool { self == .damaged }
    }

    /// How many deterministic verdicts a take gets before it is retired.
    ///
    /// Two, not one: the engine can genuinely change between attempts (the Mac
    /// reconnects and a local model answers instead of the cloud fallback), so
    /// the user gets one honest retry. A third attempt on the same bytes has
    /// never produced different text — that is the loop that made the banner
    /// permanent.
    static let maxVerdicts = 2

    /// Total attempts of ANY kind after which a take stops calling itself
    /// "pending", even though nothing ever gave a verdict on it.
    ///
    /// This is the rule the verdict counter alone could not cover, and a live
    /// reproduction is what proved it necessary. Kill the app mid-recording and
    /// AVAudioRecorder never finalizes the file, so the m4a has no `moov` atom;
    /// the server's ffmpeg refuses it and the route reports that as
    /// `503 stt_unavailable`, which is transport-shaped by every signal the phone
    /// can see. Verdicts therefore stay at 0 forever and "transcription pending"
    /// becomes permanent for a file that is simply broken — the exact banner in
    /// the report, reproduced from a clean tree.
    ///
    /// Six is chosen so it cannot be reached by one bad afternoon: each drain is
    /// a separate foreground or reconnect (rate-limited by
    /// `VoiceRecorder.autoDrainCooldown`), so six means six genuinely different
    /// moments. And unlike a verdict-retired take, this one keeps a Retry (see
    /// `retryStillPlausible`) — the claim is "this has stopped being pending",
    /// not "this can never work".
    static let attemptCeiling = 6

    /// Has this take run out of honest retries?
    ///
    /// Terminal means it leaves "pending" (the copy stops promising a
    /// transcription that will never arrive) — NOT that the audio is deleted.
    /// The file stays on disk until the user discards it or it ages out, which
    /// is the no-loss contract the whole store exists for.
    ///
    /// Two independent routes in, because the two failure shapes look nothing
    /// alike: a verdict ABOUT the audio (twice) or a great many attempts that
    /// never produced one.
    static func isTerminal(verdicts: Int, attempts: Int) -> Bool {
        verdicts >= maxVerdicts || attempts >= attemptCeiling
    }

    /// Is a manual Retry on a retired take still worth offering?
    ///
    /// No for a verdict-retired take: the engine has answered on this audio
    /// twice, and a third identical answer is the loop this whole fix removes.
    /// YES for a ceiling-retired one: nothing ever judged the audio, so a
    /// different day (a woken Mac, a different engine) can still succeed, and
    /// refusing to let the user try would turn a noisy banner into lost words.
    static func retryStillPlausible(verdicts: Int) -> Bool {
        verdicts < maxVerdicts
    }

    /// The verdict count after one more failed attempt. Only failures that say
    /// something about the AUDIO advance it; a network failure leaves it alone,
    /// which is what keeps an outage from retiring a good recording.
    ///
    /// A `damaged` answer jumps straight to the cap rather than adding one. Encoding
    /// "final now" as a COUNT rather than as a separate terminal flag is deliberate:
    /// `isTerminal` and `retryStillPlausible` both read only this number, so one
    /// assignment makes the row stop saying "pending" AND stop offering a Retry it
    /// knows cannot work. A second rule would have had to agree with the first.
    static func verdictCount(previous: Int, kind: FailureKind) -> Int {
        if kind.isFinalOnFirstVerdict { return max(previous, maxVerdicts) }
        return previous + (kind.isDeterministic ? 1 : 0)
    }

    /// Classify an upload failure. Anything that is not clearly the server's
    /// verdict on the audio counts as `transport`, i.e. the take keeps its
    /// retries: an unrecognized failure must never be what retires a recording.
    static func classify(_ error: any Error) -> FailureKind {
        guard let api = error as? APIError else { return .transport }
        if api.isCancelled { return .cancelled }
        if case .server(let status, let code, _, _, _) = api, (400..<500).contains(status) {
            // The server looked INSIDE the file and found it truncated. Its own
            // class, because it is final on the first answer (see `damaged`).
            // Matched on the code, not the status, so a future 422 for some other
            // reason keeps the ordinary two-verdict courtesy.
            return code == "bad_audio" ? .damaged : .rejected
        }
        return .transport
    }
}

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
        /// How many transcription attempts this exact audio has survived — every
        /// try, whatever the reason it failed. The log's honest denominator.
        var attempts: Int = 0
        /// How many of those attempts came back with a verdict ABOUT THE AUDIO
        /// (`FailureKind.isDeterministic`). This is the count that retires a
        /// take, so a week of failed uploads to a sleeping Mac never can.
        var verdicts: Int = 0
        /// WHICH COMPOSER this take was spoken into (`ComposerSurfaceID.raw`, or
        /// the composer's draft key when it declares no surface). nil = recorded
        /// by a build that did not stamp it.
        ///
        /// Load-bearing, not bookkeeping: the store is global while every
        /// composer owns its own `VoiceRecorder`, so without an origin any
        /// mounted composer would happily transcribe a take spoken into a
        /// different one and drop the text into ITS draft. See
        /// `VoiceRecorder.ownsForAutomaticDrain`.
        var surface: String? = nil
        /// The last attempt's message and its classification. `lastErrorKind` is
        /// what decides whether retrying is honest; `lastError` is on-disk
        /// diagnostics (it rides the drain log, no row renders it).
        var lastError: String? = nil
        var lastErrorKind: VoiceRetryPlan.FailureKind? = nil
        var lastAttemptAt: Date? = nil

        /// Out of honest retries: the row must stop saying "pending" and offer
        /// Discard instead of a Retry that provably cannot change the answer.
        var isTerminal: Bool {
            VoiceRetryPlan.isTerminal(verdicts: verdicts, attempts: attempts)
        }

        /// Retired, but by the attempt ceiling rather than by a verdict — a
        /// manual Retry can still work, so the row keeps one as a secondary.
        var retryStillPlausible: Bool {
            VoiceRetryPlan.retryStillPlausible(verdicts: verdicts)
        }
    }

    /// Sidecar payload — versioned so future fields stay decodable.
    ///
    /// v2 adds per-recording attempt bookkeeping. The decoder is HAND-WRITTEN
    /// on purpose: Swift's synthesized `Decodable` throws on a missing key even
    /// when the property has a default value, so a synthesized decoder would
    /// have failed on every v1 sidecar already on disk. `readSidecar` swallows
    /// the error, so the visible damage would have been quiet rather than loud —
    /// every preserved take losing its `createdAt` and `reason` and reappearing
    /// as `reason: "unknown"`, which is exactly the kind of silent data
    /// downgrade this store exists to prevent.
    private struct Sidecar: Codable {
        var v: Int = 2
        var createdAt: Date
        var reason: String
        var attempts: Int = 0
        var verdicts: Int = 0
        var surface: String? = nil
        var lastError: String? = nil
        var lastErrorKind: String? = nil
        var lastAttemptAt: Date? = nil

        init(
            createdAt: Date, reason: String, attempts: Int = 0, verdicts: Int = 0,
            surface: String? = nil, lastError: String? = nil, lastErrorKind: String? = nil,
            lastAttemptAt: Date? = nil
        ) {
            self.createdAt = createdAt
            self.reason = reason
            self.attempts = attempts
            self.verdicts = verdicts
            self.surface = surface
            self.lastError = lastError
            self.lastErrorKind = lastErrorKind
            self.lastAttemptAt = lastAttemptAt
        }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            // Only these two are required, and even they are the v1 shape — a
            // sidecar this decoder cannot read is a preserved recording the user
            // can no longer see the age or reason of.
            createdAt = try c.decode(Date.self, forKey: .createdAt)
            reason = try c.decode(String.self, forKey: .reason)
            v = try c.decodeIfPresent(Int.self, forKey: .v) ?? 1
            attempts = try c.decodeIfPresent(Int.self, forKey: .attempts) ?? 0
            verdicts = try c.decodeIfPresent(Int.self, forKey: .verdicts) ?? 0
            surface = try c.decodeIfPresent(String.self, forKey: .surface)
            lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
            lastErrorKind = try c.decodeIfPresent(String.self, forKey: .lastErrorKind)
            lastAttemptAt = try c.decodeIfPresent(Date.self, forKey: .lastAttemptAt)
        }
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
    ///
    /// Attempt bookkeeping is CARRIED OVER, never reset: this is called on paths
    /// that know nothing about attempts (a take being re-preserved because the
    /// view went away), and a reset there would hand a retired take its retries
    /// back and revive the permanent banner.
    /// `surface` is the ORIGIN and is written once: the first `preserve` for a
    /// take (recording start) sets it, and every later call carries it over even
    /// if it passes nil. A take cannot change which composer it was spoken into,
    /// and letting a later preserve re-stamp it would hand the take to whichever
    /// composer touched it last, which is the bug this field exists to prevent.
    func preserve(id: String, reason: String, createdAt: Date = Date(), surface: String? = nil) {
        // Keep the original createdAt when re-marking an existing recording —
        // age-based pruning must count from the take, not the last failure.
        let existing = readSidecar(id: id)
        write(Sidecar(
            createdAt: existing?.createdAt ?? createdAt, reason: reason,
            attempts: existing?.attempts ?? 0, verdicts: existing?.verdicts ?? 0,
            surface: existing?.surface ?? surface,
            lastError: existing?.lastError, lastErrorKind: existing?.lastErrorKind,
            lastAttemptAt: existing?.lastAttemptAt
        ), id: id)
    }

    /// Record one FAILED transcription attempt against a take: bump the count
    /// and remember how it failed. Preserves the audio exactly like `preserve`.
    ///
    /// The count is what lets the drain retire a take that can never succeed;
    /// the kind is what keeps a network outage from ever being the thing that
    /// retires one (see `VoiceRetryPlan.FailureKind.isDeterministic`).
    func noteAttempt(
        id: String, reason: String, kind: VoiceRetryPlan.FailureKind,
        message: String, at: Date = Date()
    ) {
        let existing = readSidecar(id: id)
        write(Sidecar(
            createdAt: existing?.createdAt ?? at, reason: reason,
            attempts: (existing?.attempts ?? 0) + 1,
            verdicts: VoiceRetryPlan.verdictCount(previous: existing?.verdicts ?? 0, kind: kind),
            surface: existing?.surface,
            lastError: message, lastErrorKind: kind.rawValue, lastAttemptAt: at
        ), id: id)
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
                reason: side?.reason ?? "unknown", bytes: bytes,
                attempts: side?.attempts ?? 0, verdicts: side?.verdicts ?? 0,
                surface: side?.surface,
                lastError: side?.lastError,
                lastErrorKind: side?.lastErrorKind.flatMap(VoiceRetryPlan.FailureKind.init(rawValue:)),
                lastAttemptAt: side?.lastAttemptAt
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

    // MARK: - Drain gate (process-wide, because the STORE is process-wide)

    /// Why this lives on the store and not on the recorder: there is exactly ONE
    /// recording directory, but every `ComposerBar` owns its own
    /// `@State VoiceRecorder` (chat, each session conversation page, the
    /// new-session sheet). An instance-local "am I already draining" flag and an
    /// instance-local cooldown are invisible to a sibling composer, so two
    /// mounted composers could upload the SAME file at the same time and the
    /// winner would delete it from under the loser. The guard has to sit where
    /// the contention is.
    ///
    /// A lock rather than MainActor isolation because the store is deliberately
    /// not actor-bound (prune runs on a detached task).
    private struct DrainGate {
        var owner: String?
        var lastAutomaticStart: Date?
    }

    private static let gate = OSAllocatedUnfairLock(initialState: DrainGate())

    enum DrainClaim: Equatable {
        case granted
        /// Another composer's recorder is draining right now.
        case busy(owner: String)
        /// An automatic drain asked again too soon (connectivity flap).
        case cooling(sinceSec: Int)
    }

    /// Try to become the one drainer. `automatic` drains additionally respect
    /// `cooldown`; a person tapping Retry never waits on a timer.
    static func claimDrain(
        owner: String, automatic: Bool, cooldown: TimeInterval, now: Date = Date()
    ) -> DrainClaim {
        gate.withLock { state in
            if let current = state.owner { return .busy(owner: current) }
            if automatic, let last = state.lastAutomaticStart,
               now.timeIntervalSince(last) < cooldown {
                return .cooling(sinceSec: Int(now.timeIntervalSince(last)))
            }
            state.owner = owner
            if automatic { state.lastAutomaticStart = now }
            return .granted
        }
    }

    /// Release the claim. Ignores a mismatched owner so a late release can never
    /// free somebody else's claim.
    static func releaseDrain(owner: String) {
        gate.withLock { state in
            if state.owner == owner { state.owner = nil }
        }
    }

    #if DEBUG
    /// Tests share one process, so the gate would otherwise leak between them:
    /// the cooldown from one test would silently suppress the next test's drain.
    static func _testResetDrainGate() {
        gate.withLock { $0 = DrainGate() }
    }
    #endif

    // MARK: - Internals

    private func sidecarURL(id: String) -> URL {
        dir.appendingPathComponent("\(id).json")
    }

    private func write(_ sidecar: Sidecar, id: String) {
        guard let data = try? JSONEncoder().encode(sidecar) else { return }
        try? data.write(to: sidecarURL(id: id), options: .atomic)
    }

    private func readSidecar(id: String) -> Sidecar? {
        guard let data = try? Data(contentsOf: sidecarURL(id: id)) else { return nil }
        return try? JSONDecoder().decode(Sidecar.self, from: data)
    }
}
