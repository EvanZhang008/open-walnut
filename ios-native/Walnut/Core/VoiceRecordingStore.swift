import Foundation
import os

/// Retry decisions for preserved voice takes — the pure core of the drain.
///
/// Extracted out of `VoiceRecorder` (which cannot be instantiated in a unit test
/// without an AVAudioSession) so the rules that actually carried the 2026-08-30
/// defect are provable: the banner "1 recording saved — transcription pending"
/// could never clear. Two independent reasons, both fixed here.
///  - The drain stopped at the FIRST failure, so one unreadable take blocked
///    every good recording behind it indefinitely.
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
    /// The file stays on disk until the user discards it, which
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

/// Durable voice history in Application Support, never a purgeable cache.
/// New takes use CAF and a sidecar written before capture starts. Older m4a
/// takes remain readable. Transcription atomically saves text without deleting
/// audio; only an explicit user discard removes a recording. There is no age
/// or count limit. Metadata updates are serialized across store instances;
/// unbounded history listings must run off the main actor.
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
        var transcript: String? = nil
        var durationSeconds: Double? = nil
        var serverID: String? = nil
        var archiveOrigin: String? = nil
        var archiveStorage: String? = nil
        /// "saved" only after a durable server acknowledgement.
        var archiveState: String? = nil
        /// nil means the primary server's persistence is unknown.
        var primarySaved: Bool? = nil
        var backupError: String? = nil
        var audioAvailable: Bool = true

        var format: String { audioURL.pathExtension.lowercased() }

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

    static let shared = VoiceRecordingStore()

    let dir: URL
    #if DEBUG
    /// A backup-write failure seam, distinct from transcript durability.
    var _testBeforeBackupWrite: (() throws -> Void)?
    #endif

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

    /// CAF is recoverable without an m4a finalization atom. Start must still
    /// successfully write the sidecar before opening the microphone.
    func newRecordingURL(id: String = UUID().uuidString) -> URL {
        Self.io.sync {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            return dir.appendingPathComponent("\(id).caf")
        }
    }

    /// Compatibility wrapper for lifecycle callers. Start checks the result;
    /// callers needing the underlying failure use `preserveOrThrow`.
    @discardableResult
    func preserve(id: String, reason: String, createdAt: Date = Date(), surface: String? = nil) -> Bool {
        do {
            try preserveOrThrow(id: id, reason: reason, createdAt: createdAt, surface: surface)
            return true
        } catch {
            AppLog.error("voice", "recording metadata save failed", ["id": id, "error": error.localizedDescription])
            return false
        }
    }

    /// Every update carries over saved words, attempt counts and backup status.
    /// A legacy origin remains unknown; a later preserve cannot invent one.
    func preserveOrThrow(id: String, reason: String, createdAt: Date = Date(), surface: String? = nil) throws {
        try Self.io.sync {
            let existing = try readSidecarUnlocked(id: id)
            var side = existing ?? Sidecar(createdAt: createdAt, reason: reason)
            side.reason = side.transcript == nil ? reason : "transcribed"
            if existing == nil { side.surface = surface }
            side.audioFormat = audioURLUnlocked(id: id)?.pathExtension.lowercased() ?? side.audioFormat ?? "caf"
            side.v = 3
            try writeUnlocked(side, id: id)
        }
    }

    /// Failed attempts update diagnostics, never reset or replace saved text.
    @discardableResult
    func noteAttempt(
        id: String, reason: String, kind: VoiceRetryPlan.FailureKind,
        message: String, at: Date = Date()
    ) -> Bool {
        do {
            try update(id: id) { side in
                side.reason = side.transcript == nil ? reason : "transcribed"
                side.attempts += 1
                side.verdicts = VoiceRetryPlan.verdictCount(previous: side.verdicts, kind: kind)
                side.lastError = message
                side.lastErrorKind = kind.rawValue
                side.lastAttemptAt = at
            }
            return true
        } catch {
            AppLog.error("voice", "recording attempt save failed", ["id": id, "error": error.localizedDescription])
            return false
        }
    }

    /// Explicit user deletion only, serialized against metadata updates.
    func discard(id: String) {
        Self.io.sync {
            for format in ["caf", "m4a", "json"] {
                try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(id).\(format)"))
            }
        }
    }

    /// Compatibility with existing launch callers. History is user-managed;
    /// launching the app must never remove old or excess recordings.
    static func pruneAtLaunch(protectedDataAvailable: Bool, store: VoiceRecordingStore = .shared) {}

    /// Retained for older callers. No age or count-based deletion.
    @discardableResult
    func prune(now: Date = Date()) -> Int { 0 }

    // MARK: - Drain gate (process-wide, because the STORE is process-wide)

    /// Why this lives on the store and not on the recorder: there is exactly ONE
    /// recording directory, but every `ComposerBar` owns its own
    /// `@State VoiceRecorder` (chat, each session conversation page, the
    /// new-session sheet). An instance-local "am I already draining" flag and an
    /// instance-local cooldown are invisible to a sibling composer, so two
    /// mounted composers could upload the SAME file at the same time and the
    /// winner would deliver the words twice. The guard has to sit where
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

}
