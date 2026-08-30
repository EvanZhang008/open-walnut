import Foundation

/// One heartbeat sample as it rides the wire — the frozen body element of
/// `POST /api/v1/time/heartbeats`.
struct TimeHeartbeatSample: Codable, Equatable, Sendable {
    /// Idempotency key, `<installId>-<seq>`. The server drops a sample whose id
    /// it has already banked, which is what makes a LOST ACK harmless instead of
    /// a double count — see `TimeSampleFormat.sampleId`.
    let id: String
    /// ISO-8601 START of the counted window. The server assigns the LOCAL DAY
    /// from this, which is exactly what lets a phone that was offline for hours
    /// still bank its time onto the day it happened.
    let ts: String
    let durationMs: Int
    /// `session` | `chat` | `triage`.
    let kind: String
    let taskId: String?
    let sessionId: String?
    /// Always `ios` — how the server tells phone attention from browser attention.
    let source: String
}

/// A closed attention window, before it becomes a wire sample. Time is kept as
/// epoch milliseconds (ONE source of truth); the ISO string is derived at send
/// time, so a sample that waits on disk for two days can't drift.
struct AttentionSample: Codable, Equatable, Sendable {
    /// START of the counted window.
    let startMs: Int64
    let durationMs: Int
    let kind: AttentionKind
    let taskId: String?
    let sessionId: String?

    func wire(id: String) -> TimeHeartbeatSample {
        TimeHeartbeatSample(
            id: id,
            ts: TimeSampleFormat.iso8601(epochMs: startMs),
            durationMs: durationMs,
            kind: kind.rawValue,
            taskId: taskId,
            sessionId: sessionId,
            source: TimeSampleFormat.source
        )
    }
}

/// A queued sample plus the client-side sequence number the commit is keyed on.
///
/// WHY A SEQ AND NOT AN INDEX: a batch is taken, sent, then committed, and an
/// `enqueue` in between can PRUNE from the head (age/size cap) — which would
/// silently shift every index and make the commit delete samples that were never
/// sent. `commit(throughSeq:)` names what was accepted, so the arithmetic can't
/// go wrong whatever happened to the queue meanwhile.
struct QueuedTimeSample: Codable, Equatable, Sendable {
    let seq: Int64
    let sample: AttentionSample

    func wire(installId: String) -> TimeHeartbeatSample {
        sample.wire(id: TimeSampleFormat.sampleId(installId: installId, seq: seq))
    }
}

enum TimeSampleFormat {
    static let source = "ios"
    /// Hard ceiling on the idempotency id, so a long id can never be the reason
    /// a whole batch is rejected.
    static let maxIdLength = 64

    /// The idempotency key for one queued sample: `<installId>-<seq>`.
    ///
    /// This is what makes a LOST ACK harmless. The server banks the batch and the
    /// 204 never reaches us — the app was suspended mid-POST, a replica lost the
    /// relay ack, the 20s timeout fired under load — so the queue (correctly)
    /// re-sends. Without a stable per-sample id that re-send is a DOUBLE COUNT,
    /// and a duplicated window is indistinguishable from real attention once it
    /// is in the day file. `installId` is minted once per install and stored in
    /// the SAME file as `nextSeq`, so the pair is unique for the life of the
    /// queue and a re-send always presents the id it presented the first time.
    static func sampleId(installId: String, seq: Int64) -> String {
        let suffix = "-\(seq)"
        let room = max(maxIdLength - suffix.count, 0)
        return String(installId.prefix(room)) + suffix
    }

    /// O(1), allocation-light ISO-8601 UTC stamp for an arbitrary instant. Same
    /// `gmtime_r` technique as `ClientLogWire.timestamp()` (reentrant, safe from
    /// any thread) but for a stored epoch rather than "now".
    static func iso8601(epochMs: Int64) -> String {
        var seconds = time_t(epochMs / 1000)
        // Truncating division rounds toward zero, so a pre-1970 instant would
        // land one second late with a positive remainder. Normalize instead of
        // emitting a stamp that reads a second off.
        var millis = Int(epochMs % 1000)
        if millis < 0 {
            millis += 1000
            seconds -= 1
        }
        var parts = tm()
        gmtime_r(&seconds, &parts)
        return String(
            format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
            parts.tm_year + 1900, parts.tm_mon + 1, parts.tm_mday,
            parts.tm_hour, parts.tm_min, parts.tm_sec, millis
        )
    }
}

/// The queue's PURE state: append, prune, batch, commit. No disk, no clock, no
/// network — so every rule below is unit-testable directly.
///
/// Caps (both of them, because either alone leaks): 48 hours of age and a hard
/// sample count. A phone that never reaches its server must not grow a file
/// forever, and time older than the server's own acceptance window
/// (`MAX_SAMPLE_AGE_MS` = 7 days) would be rejected on arrival anyway.
struct TimeSampleQueueState: Codable, Equatable, Sendable {
    /// Age at which an unsent sample is dropped.
    static let maxAgeMs: Int64 = 48 * 60 * 60 * 1000
    /// Hard ceiling on retained samples. At the 60s flush granularity a full 48h
    /// of continuous use is ~2,880 windows; context switches add more, so this
    /// leaves headroom before it ever bites.
    static let maxSamples = 5_000
    /// Samples per POST. MUST NOT exceed the server's `MAX_SAMPLES_PER_REQUEST`
    /// (200): it `slice(0, 200)`s the array and still answers 204, so an
    /// over-long batch would be reported as banked while the tail was dropped.
    static let maxBatch = 200

    /// Per-install half of every sample's idempotency id. Minted by the store on
    /// first use and kept HERE, in the same file as `nextSeq`, deliberately: the
    /// two halves must live and die together. A stable installId over a `nextSeq`
    /// that reset to 1 would re-mint ids the server already banked, and the
    /// server would then dedupe away brand-new attention — a silent, permanent
    /// undercount, which is worse than the duplicate this id exists to prevent.
    /// Optional so a file written before this field decodes instead of resetting.
    var installId: String?
    var nextSeq: Int64 = 1
    var samples: [QueuedTimeSample] = []

    var isEmpty: Bool { samples.isEmpty }
    var count: Int { samples.count }

    /// Append banked windows, then enforce both caps. Returns how many samples
    /// were dropped by the caps, so the loss is loggable instead of silent.
    @discardableResult
    mutating func append(_ incoming: [AttentionSample], now: Int64) -> Int {
        for sample in incoming {
            samples.append(QueuedTimeSample(seq: nextSeq, sample: sample))
            nextSeq += 1
        }
        return prune(now: now)
    }

    /// Drop what is too old, then what is over the count cap — OLDEST first in
    /// both cases: fresh attention is the more useful half to keep.
    ///
    /// WALL-CLOCK ASSUMPTION: `now` is wall time, not a monotonic clock, because
    /// the server dates a sample by its wall-clock `ts` and the two must agree.
    /// The cost is that a wall clock jumping FORWARD by more than 48 hours (a
    /// device with a dead battery correcting itself against NTP, a user setting
    /// the date by hand) makes every queued sample look expired and prunes it.
    /// Accepted: the alternative is keeping samples the server would reject on
    /// arrival anyway (`MAX_SAMPLE_AGE_MS` = 7 days), and the queue's whole job is
    /// to be bounded. A jump BACKWARDS is harmless here (nothing looks expired);
    /// what it costs is the OPEN window, see `AttentionWindowMachine.bank`.
    @discardableResult
    mutating func prune(now: Int64) -> Int {
        let before = samples.count
        let cutoff = now - Self.maxAgeMs
        samples.removeAll { $0.sample.startMs < cutoff }
        if samples.count > Self.maxSamples {
            samples.removeFirst(samples.count - Self.maxSamples)
        }
        return before - samples.count
    }

    /// The oldest samples, bounded by `maxBatch`. Leaves them in the queue — a
    /// sample is only ever removed by `commit`, so a failed send loses nothing.
    func batch() -> [QueuedTimeSample] {
        Array(samples.prefix(Self.maxBatch))
    }

    /// Drop everything up to and including `seq` (what the server accepted).
    mutating func commit(throughSeq seq: Int64) {
        samples.removeAll { $0.seq <= seq }
    }
}

/// Disk-backed sample queue. An `actor` so every read/write/encode happens off
/// the MainActor, and so take → send → commit can never interleave with itself.
///
/// The file lives in Application Support, NOT Caches: iOS purges Caches under
/// disk pressure, and these samples are the only record that the time happened.
/// Written atomically, so a kill mid-write leaves the previous good file.
actor TimeSampleStore {
    /// A sender that either accepts the batch or throws. Injected so the retry
    /// rules are testable with no network.
    typealias Sender = @Sendable ([TimeHeartbeatSample]) async throws -> Void

    private let fileURL: URL
    private var state = TimeSampleQueueState()
    private var loaded = false

    /// The default location: `Application Support/walnut-time-heartbeats.json`.
    static func defaultFileURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("walnut-time-heartbeats.json")
    }

    init(fileURL: URL? = nil) {
        self.fileURL = fileURL ?? Self.defaultFileURL()
    }

    /// Read the persisted queue once per process. Cheap (a few KB) and off-main;
    /// callers never have to sequence it — every entry point loads first.
    private func loadIfNeeded() {
        guard !loaded else { return }
        loaded = true
        guard let data = try? Data(contentsOf: fileURL) else { return }
        guard let decoded = try? JSONDecoder().decode(TimeSampleQueueState.self, from: data) else {
            // A corrupt file must not wedge the queue forever — start clean.
            try? FileManager.default.removeItem(at: fileURL)
            return
        }
        state = decoded
    }

    private func persist() {
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            let data = try JSONEncoder().encode(state)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            // Best-effort: the in-memory queue still holds the samples, and the
            // next persist retries. Never throw into a caller banking time.
        }
    }

    /// Bank closed windows. Persisted immediately: the next thing that happens
    /// may be the process being killed.
    func enqueue(_ samples: [AttentionSample], now: Date = Date()) async {
        guard !samples.isEmpty else { return }
        loadIfNeeded()
        let dropped = state.append(samples, now: Int64(now.timeIntervalSince1970 * 1000))
        persist()
        if dropped > 0 {
            AppLog.warn("time", "heartbeat queue capped", [
                "dropped": String(dropped), "queued": String(state.count),
            ])
        }
    }

    var queuedCount: Int {
        loadIfNeeded()
        return state.count
    }

    /// Tests only: the queue as persisted.
    func snapshot() -> TimeSampleQueueState {
        loadIfNeeded()
        return state
    }

    /// The per-install half of every sample's idempotency id, minted on first use
    /// and then stable for the life of the queue file. See
    /// `TimeSampleFormat.sampleId` for why it must not outlive `nextSeq`.
    func installId() -> String {
        loadIfNeeded()
        if let existing = state.installId, !existing.isEmpty { return existing }
        let minted = UUID().uuidString
        state.installId = minted
        persist()
        return minted
    }

    /// Result of one flush attempt, so the caller can decide about backoff
    /// without knowing anything about HTTP.
    enum FlushOutcome: Equatable {
        /// Nothing to send.
        case empty
        /// The server banked `sent` samples; `remaining` are still queued.
        case sent(count: Int, remaining: Int)
        /// The samples were KEPT. `retryable` is false only for a refusal that
        /// retrying cannot fix (an unpaired app, a 400-class rejection).
        case kept(retryable: Bool)
    }

    /// Send the oldest batch and commit ONLY on success.
    ///
    /// Every failure keeps the samples — that is the whole contract: 503 means
    /// the server can't persist right now (a replica with no primary), any other
    /// error means we don't know, and the counted window happened either way.
    /// The one case that does not deserve a retry timer is a permanent refusal
    /// (unpaired / unauthorized / a rejected body), which is reported as
    /// `kept(retryable: false)` so the caller stops hammering — the samples stay
    /// on disk regardless and go out after the next successful pairing.
    func flush(using send: Sender, now: Date = Date()) async -> FlushOutcome {
        loadIfNeeded()
        // Only a prune that actually dropped something is worth a disk write. A
        // flush runs at least once a minute for as long as the app is on screen,
        // and the common case by far is "nothing to send" — rewriting the file
        // every minute to store the same bytes is pure battery and flash wear.
        let pruned = state.prune(now: Int64(now.timeIntervalSince1970 * 1000))
        let batch = state.batch()
        guard !batch.isEmpty else {
            if pruned > 0 { persist() }
            return .empty
        }
        let id = installId()
        do {
            try await send(batch.map { $0.wire(installId: id) })
        } catch {
            if pruned > 0 { persist() } // the prune is worth keeping even on a failure
            let retryable = Self.isRetryable(error)
            AppLog.info("time", "heartbeat flush kept", [
                "queued": String(state.count),
                "retryable": retryable ? "true" : "false",
                "error": Self.describe(error),
            ])
            return .kept(retryable: retryable)
        }
        guard let lastSeq = batch.last?.seq else { return .empty }
        state.commit(throughSeq: lastSeq)
        persist()
        return .sent(count: batch.count, remaining: state.count)
    }

    /// Which failures a retry timer should keep chasing. 503 (replica offline
    /// from its primary) and any transport failure are temporary by definition.
    /// 401/404/400 are not: they need a re-pair or a client fix, and a timer
    /// would just burn battery. Pure + static so the policy is unit-testable.
    static func isRetryable(_ error: Error) -> Bool {
        guard let apiError = error as? APIError else { return true }
        switch apiError {
        case .notConfigured, .unauthorized:
            return false
        case .cancelled, .badResponse, .rateLimited:
            return true
        case .network:
            return true
        case .server(let status, _, _, _, _):
            // 5xx and 429 clear on their own; 4xx needs someone to fix something.
            return status >= 500 || status == 429
        }
    }

    private static func describe(_ error: Error) -> String {
        if let apiError = error as? APIError {
            if case .server(let status, let code, _, _, _) = apiError { return "\(status) \(code)" }
            return apiError.code ?? String(describing: apiError)
        }
        return String(describing: error)
    }
}
