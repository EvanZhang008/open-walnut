import AVFoundation
import Observation
import os

/// Seam over the live capture object so the retry/persistence state machine is
/// unit-testable without a microphone (tests inject a fake; production uses
/// AVAudioRecorder).
protocol AudioCapture: AnyObject {
    var currentTime: TimeInterval { get }
    func stop()
}

extension AVAudioRecorder: AudioCapture {}

/// Voice-input recorder: mic → m4a (AAC 16kHz mono) → server transcription.
/// The server routes to the best engine (Mac whisper via bridge when
/// reachable, OpenAI Whisper as the cloud fallback) — the phone just uploads.
/// NSObject base is required for AVAudioRecorderDelegate conformance below.
///
/// Resilience contract (field incident 2026-08-09 — a long dictation vanished
/// when the phone auto-locked mid-take):
///  - NO duration cap. Recording continues across screen lock / background
///    (UIBackgroundModes: audio keeps the process + mic alive).
///  - Audio records straight into a persistent store (Application Support via
///    `VoiceRecordingStore`) and is deleted ONLY after transcription succeeded
///    and the text was handed back — or on explicit user cancel.
///  - Every failure path (upload error, interruption, view dismissal, app
///    suspension mid-upload, crash) PRESERVES the file; the composer surfaces
///    a "saved recording — retry" affordance driven by `pendingCount`.
@Observable
@MainActor
final class VoiceRecorder: NSObject {
    enum State: Equatable {
        case idle
        case recording
        case transcribing
    }

    /// Which input the recorder binds to. `.automatic` = system routing
    /// (AirPods / headset mic when connected); `.builtInMic` = always the
    /// phone's own mic, even with a headset on. Persisted in UserDefaults,
    /// surfaced in Settings.
    enum MicRoute: String, CaseIterable {
        case automatic
        case builtInMic
    }

    static let micRouteKey = "walnut.voice.micRoute"

    /// Minimum gap between AUTOMATIC drains (`drainPending`). Long enough to
    /// swallow a connectivity flap, short enough that a real reconnect after a
    /// failed attempt is retried within seconds. Manual Retry ignores it.
    static let autoDrainCooldown: TimeInterval = 15

    static var micRoute: MicRoute {
        MicRoute(rawValue: UserDefaults.standard.string(forKey: micRouteKey) ?? "") ?? .automatic
    }

    private(set) var state: State = .idle
    private(set) var elapsed: TimeInterval = 0
    var errorMessage: String?
    /// Recordings preserved on disk that still have honest retries left (failed
    /// upload, interruption, crash) — the composer shows a retry affordance when
    /// > 0, and the auto-drain works exactly this set.
    private(set) var pendingCount = 0
    /// Recordings the engine has answered on and cannot transcribe
    /// (`VoiceRetryPlan.isTerminal`). Counted SEPARATELY from `pendingCount`
    /// because they need different words and a different button: calling them
    /// "pending" is the permanent banner (2026-08-30), and offering Retry is
    /// offering a button that provably cannot change the answer. The audio is
    /// still on disk — only the user deletes it.
    private(set) var failedCount = 0
    /// Of those, how many were retired by the ATTEMPT CEILING rather than by a
    /// verdict on the audio. Nothing ever judged these, so the retired row keeps
    /// a secondary Retry for them — see `VoiceRetryPlan.retryStillPlausible`.
    private(set) var recoverableFailedCount = 0

    private var capture: (any AudioCapture)?
    private var tickTask: Task<Void, Never>?
    private var fileURL: URL?
    /// Store id of the live take (basename of `fileURL`).
    private var recordingID: String?
    /// In-flight transcription upload; kept referenceable so tests and
    /// diagnostics can see it. Never cancelled by lifecycle anymore — a dying
    /// upload's catch path preserves the audio instead.
    @ObservationIgnored private var transcriptionTask: Task<String, Error>?
    /// Lazy (audit OBS-5): this recorder is a `@State` default value in
    /// ComposerBar, whose initial-value expression runs on EVERY struct init
    /// — SwiftUI keeps only the first instance, but each throwaway used to
    /// allocate a full WalnutAPI (fresh URLSession) at body-eval rate.
    /// Everything with real cost is deferred to first actual use.
    @ObservationIgnored private lazy var api = WalnutAPI()
    /// Durable audio home. `.shared` in production; tests inject a temp dir.
    @ObservationIgnored private let store: VoiceRecordingStore
    /// Test seam — replaces the network upload so the persistence/retry state
    /// machine runs without a server. nil in production.
    @ObservationIgnored var uploadOverride: ((Data) async throws -> String)?
    /// WHICH COMPOSER owns this recorder (`ComposerSurfaceID.raw`, or the draft
    /// key when the composer declares no surface). Set by the composer on appear.
    ///
    /// Every take this recorder starts is stamped with it, and an AUTOMATIC drain
    /// only ever touches takes carrying this same stamp. Without that, the global
    /// store plus one recorder per composer meant a session composer (whose
    /// `disabled` flips at every turn boundary) would transcribe a take spoken
    /// into the Personal AI chat and drop the text into the session's draft, with
    /// no user action at all.
    @ObservationIgnored var surface: String = ""

    /// Does this recorder adopt takes with NO origin stamp? Exactly one composer
    /// may say yes: the one that serves the Home-screen voice quick action (the
    /// chat composer). Unstamped takes come from builds before the stamp existed,
    /// and the quick action's own surface is where they were most likely spoken.
    @ObservationIgnored var ownsOrphanTakes = false

    /// Stable per-instance identity for the store's drain gate, so a claim can be
    /// released by its owner and only by its owner.
    @ObservationIgnored private let drainOwnerID = UUID().uuidString
    /// Notification tokens (interruption / media-services reset). Written on
    /// the MainActor in start(), read in deinit — hence nonisolated(unsafe).
    @ObservationIgnored nonisolated(unsafe) private var noteTokens: [NSObjectProtocol] = []

    #if DEBUG
    /// Instance counter for ComposerFreezeTests: throwaway @State default
    /// values must stay CHEAP (no URLSession, no side effects beyond this).
    static let initCount = OSAllocatedUnfairLock(initialState: 0)
    #endif

    init(store: VoiceRecordingStore = .shared) {
        self.store = store
        super.init()
        #if DEBUG
        Self.initCount.withLock { $0 += 1 }
        #endif
    }

    deinit {
        for token in noteTokens { NotificationCenter.default.removeObserver(token) }
    }

    /// Registration deferred to first start() (audit OBS-5): registering in
    /// init meant every throwaway @State instance mutated the hub's
    /// participant array. Lifecycle only matters once a recording/upload can
    /// exist, which is only after start(). Idempotent (hub dedups).
    private func ensureRegistered() {
        LifecycleHub.shared.register(self)
    }

    // MARK: - Recording

    /// Ask permission and start capturing. Returns false when the mic is
    /// unavailable (permission denied / session failure) — the caller shows
    /// `errorMessage`. NO duration limit: the take runs until the user stops
    /// it (or an interruption forces a graceful, preserving stop).
    func start() async -> Bool {
        ensureRegistered()
        ensureObservers()
        errorMessage = nil
        guard await Self.requestPermission() else {
            errorMessage = "Microphone access denied — enable it in Settings"
            return false
        }
        do {
            try await activateSession()
        } catch let failure as VoiceSessionActivationFailure {
            // Classified path (2026-08-18): the user gets a sentence they can
            // act on, and the log names the branch so a field recurrence is
            // greppable by `reason` instead of by raw OSStatus.
            errorMessage = failure.diagnosis.message
            var meta = Self.diagnosticMeta(failure.underlying, stage: "session-activate")
            meta["reason"] = failure.diagnosis.reason
            meta["attempts"] = String(failure.attempts)
            meta["failedCall"] = failure.stage
            meta["retryable"] = failure.diagnosis.retryable ? "true" : "false"
            AppLog.error("voice", "record start failed", meta)
            return false
        } catch {
            errorMessage = Self.diagnosticMessage(prefix: "Recording failed", error)
            AppLog.error("voice", "record start failed", Self.diagnosticMeta(error, stage: "session-activate"))
            return false
        }
        do {
            // Persistent home (Application Support), NOT tmp/ — iOS purges
            // tmp/ and a purge mid-take was one of the ways audio could die.
            let id = UUID().uuidString
            let url = store.newRecordingURL(id: id)
            // AAC 16kHz mono — small uploads, and speech models are trained on
            // 16kHz anyway; higher rates just cost bandwidth.
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            ]
            let rec = try AVAudioRecorder(url: url, settings: settings)
            rec.delegate = self
            guard rec.record() else {
                errorMessage = "Could not start recording"
                return false
            }
            capture = rec
            fileURL = url
            recordingID = id
            elapsed = 0
            state = .recording
            // Sidecar from second 0: a crash mid-take still leaves a
            // discoverable recording for next-launch recovery. The ORIGIN is
            // stamped here and nowhere else that matters — this is the only
            // moment at which which-composer-is-speaking is known for certain.
            store.preserve(id: id, reason: "recording", surface: originStamp)
            startTicker()
            // Housekeeping off the main actor: age-out stale preserved takes.
            let storeRef = store
            Task.detached(priority: .utility) {
                let removed = storeRef.prune()
                if removed > 0 {
                    AppLog.info("voice", "pruned stale recordings", ["count": "\(removed)"])
                }
            }
            return true
        } catch {
            errorMessage = Self.diagnosticMessage(prefix: "Recording failed", error)
            AppLog.error("voice", "record start failed", Self.diagnosticMeta(error, stage: "recorder-init"))
            return false
        }
    }

    /// Activates the shared AVAudioSession for recording. Deactivating first
    /// clears any half-configured prior state (mirrors `stopCapture()`'s
    /// teardown) before re-activating — cheap insurance against "already
    /// active with a different category" conflicts on a real device.
    ///
    /// The -50 (paramErr) minefield, learned the hard way on real devices
    /// (the simulator enforces none of this, so it always "worked" there):
    ///  - `.spokenAudio` is a playback-oriented mode; pairing it with the
    ///    record-only `.record` category is an invalid combination.
    ///  - `.notifyOthersOnDeactivation` is legal ONLY when deactivating;
    ///    passing it to `setActive(true)` is itself a -50.
    /// So: mode `.default`, and a bare `setActive(true)`.
    ///
    /// Retry shape, reworked after the 2026-08-18 field failure (build 45): two
    /// mic presses a second apart both died on OSStatus 561017449 = `'!pri'`
    /// `insufficientPriority`, i.e. another app (Phone/FaceTime/CarPlay) owned
    /// the audio category. Two things were wrong.
    ///
    /// 1. The old cadence only slept after the FIRST failure, then fired the
    ///    remaining attempts back to back — all three activations inside
    ///    ~150ms, which is no retry at all against real audio arbitration.
    ///    Now every failed attempt waits (`VoiceSessionDiagnosis.backoffMs`),
    ///    and only for codes where waiting can actually help.
    /// 2. Whatever the code, the user got the raw OSStatus. Now the classifier
    ///    owns the sentence, so contention reads as "another app is using
    ///    audio (a call?)" instead of "NSOSStatusErrorDomain 561017449".
    ///
    /// Deliberately NOT changed: the category stays `.record` + `.default` with
    /// `.allowBluetoothHFP`. Reaching for `.duckOthers`/`.mixWithOthers` to
    /// dodge the rejection is not an option — the SDK header
    /// (AVAudioSessionTypes.h) states both are valid ONLY with
    /// `.playAndRecord`, `.playback`, and `.multiRoute`, and that for other
    /// categories they default off and "cannot be changed". Passing either
    /// alongside `.record` would trade a truthful `'!pri'` for a `-50`
    /// paramErr, i.e. break every recording to soften one failure mode. And
    /// `'!pri'` is arbitration by a higher-priority app; mixability is not the
    /// lever that wins it. See the -50 minefield note above.
    private func activateSession() async throws {
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        let wantBuiltIn = Self.micRoute == .builtInMic
        var lastFailure: VoiceSessionActivationFailure?
        // `bare` starts false and latches true when a diagnosis says our own
        // option combo was rejected — the one case where repeating the same
        // request is pointless but a simpler one may work.
        var bare = wantBuiltIn
        for attempt in 0..<VoiceSessionDiagnosis.maxAttempts {
            var stage = "set-category"
            do {
                if bare {
                    // Built-in-mic route (or a rejected option combo): omit
                    // .allowBluetoothHFP so AirPods / BT headsets never become
                    // eligible inputs at all — the category shape alone
                    // excludes them (wired headsets are handled by
                    // setPreferredInput below).
                    try session.setCategory(.record, mode: .default)
                } else {
                    try session.setCategory(.record, mode: .default, options: .allowBluetoothHFP)
                }
                stage = "set-active"
                try session.setActive(true)
                if wantBuiltIn {
                    // Pin the built-in mic even when a wired headset is
                    // plugged in. Best-effort: an unavailable port (should
                    // never happen — every iPhone has one) must not kill the
                    // recording, so failures just log.
                    if let builtIn = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
                        do { try session.setPreferredInput(builtIn) } catch {
                            AppLog.error("voice", "setPreferredInput failed", Self.diagnosticMeta(error, stage: "prefer-builtin"))
                        }
                    }
                }
                if attempt > 0 {
                    // Prove the retry earned its keep — otherwise a recovered
                    // activation is indistinguishable from a clean one.
                    AppLog.info("voice", "session activated after retry", [
                        "attempts": String(attempt + 1),
                        "lastReason": lastFailure?.diagnosis.reason ?? "unknown",
                    ])
                }
                return
            } catch let error as NSError {
                let diagnosis = VoiceSessionDiagnosis.classify(error)
                lastFailure = VoiceSessionActivationFailure(
                    underlying: error, diagnosis: diagnosis,
                    attempts: attempt + 1, stage: stage
                )
                // A config rejection is worth one more attempt ONLY if it can
                // actually change the request. Already bare and still rejected
                // means there is nothing simpler left to try.
                let canSimplify = diagnosis.tryBareConfig && !bare
                if diagnosis.tryBareConfig { bare = true }
                // Give up early when waiting provably cannot help (no mic
                // hardware, our own illegal options): the user should get the
                // real answer now, not after 800ms of theatre. `canSimplify`
                // still buys one more immediate attempt with a simpler shape.
                guard diagnosis.retryable || canSimplify else { break }
                guard let waitMs = VoiceSessionDiagnosis.backoff(afterAttempt: attempt) else { break }
                // A pure config rejection needs a different request, not time.
                if diagnosis.retryable {
                    AppLog.warn("voice", "session activate retrying", [
                        "reason": diagnosis.reason,
                        "attempt": String(attempt + 1),
                        "waitMs": String(waitMs),
                        "fourCC": VoiceSessionDiagnosis.fourCC(error.code) ?? "n/a",
                    ])
                    try? await Task.sleep(for: .milliseconds(waitMs))
                }
            }
        }
        if let lastFailure { throw lastFailure }
        // Unreachable in practice (the loop always records a failure before
        // exiting), but a silent success-shaped return would be worse.
        let fallback = NSError(domain: NSOSStatusErrorDomain, code: 0)
        throw VoiceSessionActivationFailure(
            underlying: fallback, diagnosis: .classify(fallback),
            attempts: VoiceSessionDiagnosis.maxAttempts, stage: "set-active"
        )
    }

    /// Stop and upload for transcription. Returns the recognized text, or nil
    /// on failure (with `errorMessage` set). The audio file is deleted ONLY
    /// on success — every failure keeps it recoverable via `retryPending()`.
    func stopAndTranscribe() async -> String? {
        guard state == .recording, let url = fileURL, let id = recordingID else { return nil }
        stopCapture()
        state = .transcribing
        defer {
            state = .idle
            fileURL = nil
            recordingID = nil
            refreshPending()
        }
        if case .text(let text) = await transcribeOne(url: url, id: id) {
            return text
        }
        return nil
    }

    /// Discard the current recording without transcribing — the user's
    /// explicit ✕. The ONLY path that deletes un-transcribed audio on request.
    func cancel() {
        guard state == .recording else { return }
        stopCapture()
        if let id = recordingID { store.discard(id: id) }
        fileURL = nil
        recordingID = nil
        state = .idle
        refreshPending()
    }

    /// Stop WITHOUT transcribing but KEEP the audio (view dismissed mid-take,
    /// forced teardown). Recoverable via the pending-recordings affordance.
    func preserveAndStop(reason: String) {
        guard state == .recording else { return }
        stopCapture()
        if let id = recordingID {
            store.preserve(id: id, reason: reason, surface: originStamp)
            AppLog.info("voice", "recording preserved", ["reason": reason, "id": id, "elapsed": String(Int(elapsed))])
        }
        fileURL = nil
        recordingID = nil
        state = .idle
        refreshPending()
    }

    // MARK: - Preserved recordings (retry surface)

    /// What this recorder stamps onto takes it starts. nil only when the composer
    /// never told us who it is, which would make the take unattributable — better
    /// to leave it unstamped (and therefore adoptable only by the quick-action
    /// composer) than to invent an owner.
    private var originStamp: String? {
        surface.isEmpty ? nil : surface
    }

    /// May an AUTOMATIC drain (foreground, reconnect, appear) touch this take?
    ///
    /// The rule is ownership, and it is deliberately strict: a drain runs with no
    /// human in the loop, so the transcript must land in the composer the words
    /// were spoken into and nowhere else. A MANUAL Retry is not filtered this way
    /// on purpose — that is a person tapping a button on a row they can see, and
    /// the text landing in the draft in front of them is what they asked for.
    /// That distinction is the whole fix: cross-surface recovery keeps working,
    /// but only with the human back in the loop.
    func ownsForAutomaticDrain(_ recording: VoiceRecordingStore.Recording) -> Bool {
        guard let takeSurface = recording.surface else { return ownsOrphanTakes }
        return !surface.isEmpty && takeSurface == surface
    }

    /// Recount preserved takes (excluding the live one), split into the two
    /// buckets the UI must not conflate. Synchronous: the store directory is
    /// capped at `VoiceRecordingStore.maxCount` entries, so this is one tiny
    /// directory listing.
    func refreshPending() {
        let live = recordingID
        let recs = store.pending().filter { $0.id != live }
        pendingCount = recs.filter { !$0.isTerminal }.count
        failedCount = recs.count - pendingCount
        recoverableFailedCount = recs.filter { $0.isTerminal && $0.retryStillPlausible }.count
    }

    /// Transcribe every preserved take that still has retries left, oldest
    /// first (the order they were spoken). Successes are deleted and their text
    /// concatenated.
    ///
    /// A failure NO LONGER STOPS THE DRAIN. The old loop `break`ed at the first
    /// one, so a single take the engine could not read held every good recording
    /// behind it hostage for the full 7-day retention: the user saw "3
    /// recordings saved — transcription pending" and every Retry tap reproduced
    /// the same head-of-line failure. Each take is now attempted independently
    /// and its verdict recorded on its own sidecar, and takes that have used up
    /// their retries are skipped rather than re-uploaded to fail again.
    ///
    /// `userInitiated` distinguishes the Retry TAP from the automatic drain
    /// (foreground, reconnect) in three concrete ways, and the docstring used to
    /// claim only the first one while the code did none of them:
    ///  1. VOLUME. A tap must never look like nothing happened, so it always ends
    ///     with something in `errorMessage` if it recovered nothing. An automatic
    ///     drain sets `errorMessage` NOWHERE — not here, and not in `note()`
    ///     either, which is where the leak actually was (it assigned the notice
    ///     for every failure regardless of trigger, so foregrounding the app while
    ///     the Mac slept popped a mic-slash notice nobody asked for). Row COUNTS
    ///     still move, and a terminal retirement still changes which row is shown:
    ///     that is state the user needs, not an interruption.
    ///  2. OWNERSHIP. Only a tap may work another surface's takes (see
    ///     `ownsForAutomaticDrain`).
    ///  3. RATE. Only the automatic path is subject to the store's cooldown.
    ///
    /// `includeRetired` is the retired row's secondary Retry: it re-admits takes
    /// that were retired by the ATTEMPT CEILING (nothing ever judged the audio,
    /// so a woken Mac can still transcribe them) while still refusing the ones a
    /// verdict retired. The automatic drain never sets it.
    @discardableResult
    func retryPending(
        userInitiated: Bool = true, includeRetired: Bool = false, now: Date = Date()
    ) async -> String? {
        guard state == .idle else { return nil }
        let live = recordingID
        var recs = store.pending().filter { $0.id != live }
        // An automatic drain only works takes THIS composer owns; a manual retry
        // works whatever the visible row is offering (see `ownsForAutomaticDrain`).
        if !userInitiated { recs = recs.filter { ownsForAutomaticDrain($0) } }
        guard !recs.isEmpty else {
            refreshPending()
            return nil
        }
        // The claim is store-level and covers BOTH triggers, because the hazard is
        // trigger-independent: two composers uploading the same file, the winner
        // deleting it under the loser. It also carries the automatic cooldown, so
        // a connectivity flap cannot be re-armed by a sibling composer that never
        // saw the previous attempt.
        let claim = VoiceRecordingStore.claimDrain(
            owner: drainOwnerID, automatic: !userInitiated,
            cooldown: Self.autoDrainCooldown, now: now
        )
        guard claim == .granted else {
            AppLog.info("voice", "drain not claimed", [
                "trigger": userInitiated ? "user" : "auto",
                "reason": String(describing: claim),
                "surface": surface.isEmpty ? "none" : surface,
            ])
            // A TAP must never look like nothing happened, and losing the claim is
            // the one refusal that reaches a tap: another composer (or a drain that
            // started a moment ago on this one) is mid-upload. Say so, honestly and
            // briefly, instead of returning nil into silence.
            if userInitiated {
                errorMessage = "Another upload is in progress — try again in a moment"
            }
            return nil
        }
        // A TAP clears the old notice up front: the user is watching this attempt
        // and a stale sentence from the last one is noise. An automatic drain must
        // not, because clearing is itself a visible change — it would wipe a notice
        // the user has not read yet, on a foreground they did not ask anything of.
        // It clears only when it actually recovers something (below).
        if userInitiated { errorMessage = nil }
        state = .transcribing
        defer {
            VoiceRecordingStore.releaseDrain(owner: drainOwnerID)
            state = .idle
            refreshPending()
        }
        var parts: [String] = []
        var attempted = 0
        var failed = 0
        var retired = 0
        for rec in recs {
            let admissible = !rec.isTerminal || (includeRetired && rec.retryStillPlausible)
            guard admissible else {
                retired += 1
                continue
            }
            attempted += 1
            switch await transcribeOne(
                url: rec.audioURL, id: rec.id,
                trigger: userInitiated ? .userRetry : .autoDrain
            ) {
            case .text(let text): parts.append(text)
            case .discarded: continue // too-short/no-speech: nothing to keep
            // The bug fix in one word: keep going. The remaining takes are
            // independent uploads and one bad take is not evidence about them.
            case .failed, .cancelled: failed += 1
            }
        }
        AppLog.info("voice", "retry drain finished", [
            "trigger": userInitiated ? "user" : "auto",
            "queued": String(recs.count), "attempted": String(attempted),
            "recovered": String(parts.count), "failed": String(failed),
            "skippedTerminal": String(retired),
        ])
        // Recovery is the one outcome that retracts a notice on any trigger: the
        // words are in the draft now, so "Voice unavailable" has become false.
        if !parts.isEmpty { errorMessage = nil }
        // A Retry tap must always answer. `transcribeOne` speaks for every
        // failure it makes, so the only silent outcomes left are "everything
        // here is already retired" (nothing was attempted) and a drain whose
        // failures were all quiet background cancellations.
        if userInitiated, parts.isEmpty, errorMessage == nil {
            if attempted == 0, retired > 0 {
                errorMessage = retired == 1
                    ? "That recording couldn't be transcribed — Discard to clear it"
                    : "\(retired) recordings couldn't be transcribed — Discard to clear them"
            } else if failed > 0 {
                errorMessage = "Transcription didn't go through — recordings kept"
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    /// Automatic drain — app foregrounded, or the connection came back. Fires
    /// and forgets; the recovered text is handed to `onDrainedText`.
    ///
    /// This is the leg that was missing entirely (`resumeForForeground()` was an
    /// empty body): a take saved during an outage waited for a human to notice a
    /// banner and tap Retry, forever. Results ALWAYS land in the draft — an
    /// unattended send of words the user spoke minutes ago and never saw is
    /// worse than a draft they can read (the same rule the quick action's
    /// `clear(reason:)` discipline encodes in the composer).
    /// Ownership is enforced HERE as well as inside `retryPending`, so a composer
    /// that owns nothing drainable never even schedules a Task. The cooldown and
    /// the single-flight claim live in the store (see `claimDrain`) because an
    /// instance-local version of either is invisible to the sibling composers that
    /// share the one recording directory.
    func drainPending(trigger: String, now: Date = Date()) {
        guard state == .idle else { return }
        let live = recordingID
        let mine = store.pending().filter {
            $0.id != live && !$0.isTerminal && ownsForAutomaticDrain($0)
        }
        guard !mine.isEmpty else { return }
        AppLog.info("voice", "auto-drain starting", [
            "trigger": trigger, "count": String(mine.count),
            "surface": surface.isEmpty ? "none" : surface,
            "ownsOrphans": ownsOrphanTakes ? "true" : "false",
        ])
        Task { [weak self] in
            guard let self else { return }
            if let text = await self.retryPending(userInitiated: false, now: now) {
                self.onDrainedText?(text)
            }
        }
    }

    /// Delete every preserved take that is still retryable — the user's
    /// explicit "discard saved" on the pending row. Deliberately does NOT touch
    /// retired takes: they have their own row and their own Discard, so one
    /// button can never sweep away recordings the other row is talking about.
    func discardPending() {
        for rec in store.pending() where rec.id != recordingID && !rec.isTerminal {
            store.discard(id: rec.id)
        }
        refreshPending()
    }

    /// Delete the takes that couldn't be transcribed — the primary action on
    /// the retired row, and the ONLY way those files leave before the 7-day
    /// age-out.
    func discardFailed() {
        for rec in store.pending() where rec.id != recordingID && rec.isTerminal {
            AppLog.info("voice", "retired recording discarded", [
                "id": rec.id, "attempts": String(rec.attempts),
                "lastErrorKind": rec.lastErrorKind?.rawValue ?? "none",
            ])
            store.discard(id: rec.id)
        }
        refreshPending()
    }

    // MARK: - Internals

    private enum TranscribeOutcome {
        case text(String)   // success — audio deleted
        case discarded      // nothing worth keeping (sub-second tap)
        case failed         // audio preserved, errorMessage set
        case cancelled      // torn down mid-upload — audio preserved
    }

    /// WHO asked for this attempt. Only affects how an outcome is reported, and
    /// exactly one outcome cares: a cancellation.
    ///
    /// A cancelled upload during a live take or a background drain is lifecycle
    /// noise the user did not ask about, and shouting at them about it was
    /// deliberately avoided. But the same silence on a Retry TAP made the button
    /// a total no-op: the row stayed, no message appeared, nothing moved. A tap
    /// always gets an answer.
    private enum AttemptTrigger: String {
        case liveTake, userRetry, autoDrain

        var isUserRetry: Bool { self == .userRetry }

        /// Nobody asked for this attempt, so nobody is owed a notice.
        ///
        /// `liveTake` and `userRetry` are both a person acting and watching: they
        /// get the sentence. An `autoDrain` fires on a foreground or a reconnect,
        /// and popping the mic-slash notice for a Mac that is still asleep is
        /// nagging someone about work they never requested (and, before the
        /// ownership rule, could nag on a session composer about a chat
        /// recording). It logs instead. A terminal RETIREMENT still updates the
        /// row state, because that is a change to what the UI must claim, not a
        /// complaint.
        var isSilent: Bool { self == .autoDrain }
    }

    /// Upload one take. Deletes the audio ONLY on success; every failure
    /// preserves it, records the attempt on its sidecar (count + classified
    /// kind, which is what decides whether a Retry is still honest), and logs
    /// structured diagnostics for the flight recorder.
    private func transcribeOne(
        url: URL, id: String, trigger: AttemptTrigger = .liveTake
    ) async -> TranscribeOutcome {
        do {
            // Read the recording OFF the MainActor — a long m4a is a real file
            // read, and this method runs on the actor that draws the UI.
            let data = try await Task.detached(priority: .userInitiated) {
                try Data(contentsOf: url)
            }.value
            guard data.count > 1_000 else {
                // Sub-second accidental tap — there is no speech to lose. Silent
                // for an automatic drain for the same reason every other outcome
                // is: nobody asked, and the row count moving is the whole story.
                if !trigger.isSilent { errorMessage = "Recording too short" }
                store.discard(id: id)
                return .discarded
            }
            // Background grace: if the user locks/switches away right after
            // hitting stop, this assertion buys the upload ~30s to finish
            // instead of dying suspended. If it dies anyway, the catch paths
            // below preserve the audio.
            let assertion = BackgroundAssertion.begin("voice-transcribe")
            defer { BackgroundAssertion.end(assertion) }
            let apiRef = api
            let override = uploadOverride
            let task = Task {
                if let override { return try await override(data) }
                return try await apiRef.transcribeVoice(audio: data, format: "m4a")
            }
            transcriptionTask = task
            defer { transcriptionTask = nil }
            let text = try await task.value
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                // The server answered but heard nothing. Keep the audio — an
                // engine mishearing real speech must not destroy the take — but
                // COUNT the verdict: the same bytes through the same engine will
                // answer the same way, and pretending otherwise is what left the
                // banner up forever.
                return note(
                    .empty, id: id, message: "No speech recognized",
                    userNotice: "No speech recognized — recording kept",
                    trigger: trigger, extra: ["bytes": "\(data.count)"]
                )
            }
            AppLog.info("voice", "transcribed", ["chars": "\(trimmed.count)", "bytes": "\(data.count)", "id": id])
            // Freeze-report breadcrumb: a field freeze fired ~5s after a
            // transcription landed 148 chars in the draft and re-focused the
            // keyboard, so this edge must be visible in the trail.
            FreezeContext.shared.note("voice-transcribed", trimmed.utf8.count)
            // The ONE success path that deletes audio: text is in hand.
            store.markTranscribed(id: id)
            return .text(trimmed)
        } catch let error as APIError {
            if error.isCancelled { return noteCancelled(id: id, trigger: trigger) }
            return note(
                VoiceRetryPlan.classify(error), id: id,
                message: error.localizedDescription,
                userNotice: "\(error.voiceNotice) — recording saved",
                trigger: trigger
            )
        } catch is CancellationError {
            return noteCancelled(id: id, trigger: trigger)
        } catch {
            return note(
                VoiceRetryPlan.classify(error), id: id,
                message: (error as NSError).localizedDescription,
                userNotice: "\(Self.diagnosticMessage(prefix: "Transcription failed", error)) — recording saved",
                trigger: trigger, extra: Self.diagnosticMeta(error)
            )
        }
    }

    /// One place where a failed attempt is written down, so no path can preserve
    /// audio without also recording WHY — an unattributed preserve is a take
    /// that can never be retired and therefore a banner that never clears.
    private func note(
        _ kind: VoiceRetryPlan.FailureKind, id: String, message: String,
        userNotice: String?, trigger: AttemptTrigger, extra: [String: String] = [:]
    ) -> TranscribeOutcome {
        store.noteAttempt(id: id, reason: "transcribe-failed", kind: kind, message: message)
        // Re-read rather than recompute: the sidecar on disk is the only thing
        // the next drain will consult, so the message the user sees now and the
        // decision the drain makes later cannot disagree.
        let after = store.pending().first { $0.id == id }
        let attempts = after?.attempts ?? 0
        let retired = after?.isTerminal ?? false
        // An automatic drain says nothing out loud; the row state it produces
        // (`refreshPending` moving the take into the retired bucket) is the only
        // thing the user sees, and that is a fact, not a notice.
        if !trigger.isSilent {
            if retired {
                // Say the true thing. "Pending" was the lie the user reported.
                // A DAMAGED file gets the stronger sentence: "keep it for later"
                // would be advice we know is worthless, since no later attempt can
                // decode a truncated container.
                errorMessage = kind == .damaged
                    ? "That recording is damaged and can't be transcribed — Discard it"
                    : "Couldn't transcribe that recording — Discard it or keep it for later"
            } else if let userNotice {
                errorMessage = userNotice
            }
        }
        var meta = extra
        meta["id"] = id
        meta["kind"] = kind.rawValue
        meta["attempts"] = String(attempts)
        meta["verdicts"] = String(after?.verdicts ?? 0)
        meta["retired"] = retired ? "true" : "false"
        meta["trigger"] = trigger.rawValue
        meta["reason"] = message
        if retired {
            AppLog.error("voice", "recording retired — cannot transcribe", meta)
        } else {
            AppLog.warn("voice", "transcribe attempt failed — preserved", meta)
        }
        return .failed
    }

    /// A torn-down upload. The audio is preserved either way; the difference is
    /// whether anyone is owed an answer (see `AttemptTrigger`).
    private func noteCancelled(id: String, trigger: AttemptTrigger) -> TranscribeOutcome {
        store.noteAttempt(
            id: id, reason: "background", kind: .cancelled,
            message: "upload cancelled"
        )
        if trigger.isUserRetry {
            errorMessage = "Retry interrupted — recording kept"
        }
        AppLog.info("voice", "upload cancelled — preserved", [
            "id": id, "trigger": trigger.rawValue,
            "notified": trigger.isUserRetry ? "true" : "false",
        ])
        return .cancelled
    }

    private func stopCapture() {
        tickTask?.cancel()
        tickTask = nil
        capture?.stop()
        capture = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Elapsed-time ticker for the recording row. Display only — there is NO
    /// duration cap (removed 2026-08-10: the old 90s auto-stop compounded the
    /// lock-screen data loss and violated "recording has no time limit").
    private func startTicker() {
        tickTask?.cancel()
        tickTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(0.5))
                guard let self, self.state == .recording else { return }
                self.elapsed = self.capture?.currentTime ?? self.elapsed + 0.5
            }
        }
    }

    /// Interruption-stop path (phone call, Siri, media-services reset): the
    /// composer registers a handler to receive text from the auto-attempted
    /// transcription of the preserved partial take.
    var onAutoStopText: ((String) -> Void)?

    /// Text recovered by the AUTOMATIC drain (foreground, reconnect). A separate
    /// channel from `onAutoStopText` on purpose: that one feeds the composer's
    /// `deliver`, which may auto-send a quick-action take, and a drain result
    /// must NEVER be able to reach that path. Words spoken minutes ago that the
    /// user has not seen go into the draft, where they can read them first.
    var onDrainedText: ((String) -> Void)?

    /// System interruptions & media-server resets end the take for us. Stop
    /// gracefully, PRESERVE the partial audio, then immediately try to
    /// transcribe it — success lands in the composer via `onAutoStopText`,
    /// failure leaves it on the retry surface. Never discards.
    private func handleInterruptionBegan(kind: String) {
        guard state == .recording else { return }
        AppLog.warn("voice", "recording interrupted — preserving", ["kind": kind, "elapsed": String(Int(elapsed))])
        preserveAndStop(reason: "interrupted")
        Task { [weak self] in
            guard let self else { return }
            if let text = await self.retryPending() {
                self.onAutoStopText?(text)
            }
        }
    }

    /// Observe interruption + media-services-reset once per instance. Lazy
    /// (first start()) for the same OBS-5 reason as LifecycleHub registration.
    private func ensureObservers() {
        guard noteTokens.isEmpty else { return }
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        let interruption = center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: session, queue: nil
        ) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            guard raw == AVAudioSession.InterruptionType.began.rawValue else { return }
            Task { @MainActor [weak self] in
                self?.handleInterruptionBegan(kind: "interruption")
            }
        }
        let reset = center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.handleInterruptionBegan(kind: "media-services-reset")
            }
        }
        noteTokens = [interruption, reset]
    }

    #if DEBUG
    /// Test hook: enter `.recording` with an injected capture + a file the
    /// test wrote — the persistence/retry state machine runs without a mic.
    func _testBeginTake(capture: any AudioCapture, url: URL, id: String) {
        self.capture = capture
        fileURL = url
        recordingID = id
        elapsed = 0
        state = .recording
        store.preserve(id: id, reason: "recording", surface: originStamp)
    }

    /// Test hook: drive the interruption path directly (no way to synthesize
    /// a real AVAudioSession interruption in a unit test).
    func _testSimulateInterruption() {
        handleInterruptionBegan(kind: "test")
    }
    #endif

    private static func requestPermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        case .undetermined:
            return await AVAudioApplication.requestRecordPermission()
        @unknown default: return false
        }
    }

    /// Domain + code are prepended unconditionally so this is never just
    /// Foundation's generic "The operation couldn't be completed." fallback.
    private static func diagnosticMessage(prefix: String, _ error: Error) -> String {
        let nsError = error as NSError
        return "\(prefix): \(nsError.domain) \(nsError.code) — \(nsError.localizedDescription)"
    }

    private static func diagnosticMeta(_ error: Error, stage: String = "") -> [String: String] {
        let nsError = error as NSError
        let underlying = (nsError.userInfo[NSUnderlyingErrorKey] as? NSError)
            .map { "\($0.domain) \($0.code)" } ?? "none"
        var meta = [
            "domain": nsError.domain,
            "code": String(nsError.code),
            "desc": nsError.localizedDescription,
            "underlying": underlying,
        ]
        // The FourCC is the whole reason the 2026-08-18 log took a manual decode
        // to read: `561017449` says nothing, `'!pri'` greps straight to the SDK
        // enum. Emitted for every OSStatus, not just activation failures.
        if let fourCC = VoiceSessionDiagnosis.fourCC(nsError.code) { meta["fourCC"] = fourCC }
        if !stage.isEmpty { meta["stage"] = stage }
        return meta
    }
}

extension VoiceRecorder: LifecycleSuspendable {
    /// Background/lock does NOT stop anything anymore (field incident
    /// 2026-08-09: this used to cancel() and silently DELETE a live take when
    /// the screen auto-locked).
    ///  - recording: UIBackgroundModes[audio] keeps the process + mic alive;
    ///    the take continues across lock and returns intact on unlock.
    ///  - transcribing: the upload already holds a background assertion; if
    ///    iOS suspends us anyway the failure path preserves the audio.
    func suspendForBackground() {
        switch state {
        case .recording:
            AppLog.info("voice", "recording continues in background", ["elapsed": String(Int(elapsed))])
        case .transcribing, .idle:
            break
        }
    }

    /// Coming back to the foreground is the best moment to clear the backlog:
    /// the app has the network again (usually), the user is looking at it, and
    /// nothing is recording. This used to be an EMPTY BODY — a take saved during
    /// an outage sat there until a human noticed the banner and tapped Retry,
    /// which is why "1 recording saved — transcription pending" could look
    /// permanent even when the server had been reachable for hours.
    func resumeForForeground() {
        refreshPending()
        drainPending(trigger: "foreground")
    }
}

extension VoiceRecorder: AVAudioRecorderDelegate {
    /// Encode failures happen mid-recording with no throw site to catch —
    /// without this delegate they were entirely silent (state stuck on
    /// `.recording` until the user manually stopped a dead recorder).
    /// Whatever audio made it to disk before the failure is PRESERVED.
    nonisolated func audioRecorderEncodeErrorDidOccur(_ audioRecorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor in
            let error = error ?? NSError(domain: NSOSStatusErrorDomain, code: 0)
            self.preserveAndStop(reason: "encode-error")
            self.errorMessage = Self.diagnosticMessage(prefix: "Recording failed", error)
            AppLog.error("voice", "encode error — partial take preserved", Self.diagnosticMeta(error))
        }
    }

    /// `successfully: false` = the system finalized the file after a failure
    /// (route died, storage hiccup). Same preserving treatment.
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        guard !flag else { return }
        Task { @MainActor in
            guard self.state == .recording else { return }
            self.preserveAndStop(reason: "finish-failed")
            self.errorMessage = "Recording stopped unexpectedly — saved for retry"
            AppLog.error("voice", "finish unsuccessful — partial take preserved", nil)
        }
    }
}

extension APIError {
    /// Voice-flow friendly message — surfaces the server's stt_unavailable
    /// explanation instead of a generic HTTP error.
    var voiceNotice: String {
        if case let .server(_, code, message, _, _) = self {
            if code == "stt_unavailable" { return "Voice unavailable: \(message)" }
            return message
        }
        if case .notConfigured = self { return "Not connected to a server" }
        return "Transcription failed — check your connection"
    }
}
