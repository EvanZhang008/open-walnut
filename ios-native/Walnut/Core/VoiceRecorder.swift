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

    static var micRoute: MicRoute {
        MicRoute(rawValue: UserDefaults.standard.string(forKey: micRouteKey) ?? "") ?? .automatic
    }

    private(set) var state: State = .idle
    private(set) var elapsed: TimeInterval = 0
    var errorMessage: String?
    /// Recordings preserved on disk awaiting transcription (failed upload,
    /// interruption, crash) — the composer shows a retry affordance when > 0.
    private(set) var pendingCount = 0

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
            // discoverable recording for next-launch recovery.
            store.preserve(id: id, reason: "recording")
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
    /// Two safety nets: `.isBusy`/`.insufficientPriority` are transient
    /// (another app briefly holding the session) and get one short retry;
    /// any other error on the full-option config falls back once to the
    /// barest legal combo (no options) so an exotic option rejection on
    /// some device still ends in a working recording.
    private func activateSession() async throws {
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        let wantBuiltIn = Self.micRoute == .builtInMic
        var lastError: NSError?
        for attempt in 0...2 {
            do {
                if attempt < 2 && !wantBuiltIn {
                    try session.setCategory(.record, mode: .default, options: .allowBluetoothHFP)
                } else {
                    // Built-in-mic route: omit .allowBluetoothHFP so AirPods /
                    // BT headsets never become eligible inputs at all — the
                    // category shape alone excludes them (wired headsets are
                    // handled by setPreferredInput below).
                    try session.setCategory(.record, mode: .default)
                }
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
                return
            } catch let error as NSError {
                lastError = error
                let transient = error.domain == NSOSStatusErrorDomain
                    && [AVAudioSession.ErrorCode.isBusy.rawValue,
                        AVAudioSession.ErrorCode.insufficientPriority.rawValue].contains(error.code)
                if attempt == 0 && transient {
                    try? await Task.sleep(for: .milliseconds(150))
                    continue
                }
                // Non-transient: fall through once to the no-options combo.
                if attempt < 2 { continue }
            }
        }
        throw lastError ?? NSError(domain: NSOSStatusErrorDomain, code: 0)
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
            store.preserve(id: id, reason: reason)
            AppLog.info("voice", "recording preserved", ["reason": reason, "id": id, "elapsed": String(Int(elapsed))])
        }
        fileURL = nil
        recordingID = nil
        state = .idle
        refreshPending()
    }

    // MARK: - Preserved recordings (retry surface)

    /// Recount preserved takes (excluding the live one). Synchronous: the
    /// store directory is capped at `VoiceRecordingStore.maxCount` entries,
    /// so this is one tiny directory listing.
    func refreshPending() {
        let live = recordingID
        pendingCount = store.pending().filter { $0.id != live }.count
    }

    /// Transcribe every preserved take, oldest first (the order they were
    /// spoken). Successes are deleted and their text concatenated; the first
    /// hard failure stops the loop and leaves the remainder preserved.
    func retryPending() async -> String? {
        guard state == .idle else { return nil }
        errorMessage = nil
        let recs = store.pending()
        guard !recs.isEmpty else {
            refreshPending()
            return nil
        }
        state = .transcribing
        defer {
            state = .idle
            refreshPending()
        }
        var parts: [String] = []
        loop: for rec in recs {
            switch await transcribeOne(url: rec.audioURL, id: rec.id) {
            case .text(let text): parts.append(text)
            case .discarded: continue // too-short/no-speech: nothing to keep
            case .failed, .cancelled: break loop
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    /// Delete every preserved take — the user's explicit "discard saved".
    func discardPending() {
        for rec in store.pending() where rec.id != recordingID {
            store.discard(id: rec.id)
        }
        refreshPending()
    }

    // MARK: - Internals

    private enum TranscribeOutcome {
        case text(String)   // success — audio deleted
        case discarded      // nothing worth keeping (sub-second tap)
        case failed         // audio preserved, errorMessage set
        case cancelled      // lifecycle cancel — audio preserved, no error UI
    }

    /// Upload one take. Deletes the audio ONLY on success; every failure
    /// preserves it with a reason on the sidecar and structured logging
    /// (domain/code ride the flight recorder for field diagnosis).
    private func transcribeOne(url: URL, id: String) async -> TranscribeOutcome {
        do {
            // Read the recording OFF the MainActor — a long m4a is a real file
            // read, and this method runs on the actor that draws the UI.
            let data = try await Task.detached(priority: .userInitiated) {
                try Data(contentsOf: url)
            }.value
            guard data.count > 1_000 else {
                // Sub-second accidental tap — there is no speech to lose.
                errorMessage = "Recording too short"
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
                // engine mishearing real speech must not destroy the take.
                errorMessage = "No speech recognized — recording kept"
                store.preserve(id: id, reason: "transcribe-failed")
                AppLog.warn("voice", "empty transcription — preserved", ["id": id, "bytes": "\(data.count)"])
                return .failed
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
            if error.isCancelled {
                // Lifecycle (task torn down mid-flight) — not a user-visible
                // error; the preserved take resurfaces via the retry row.
                store.preserve(id: id, reason: "background")
                AppLog.info("voice", "upload cancelled — preserved", ["id": id])
                return .cancelled
            }
            errorMessage = "\(error.voiceNotice) — recording saved"
            store.preserve(id: id, reason: "transcribe-failed")
            AppLog.error("voice", "transcribe failed — preserved", ["id": id, "error": error.localizedDescription])
            return .failed
        } catch is CancellationError {
            store.preserve(id: id, reason: "background")
            AppLog.info("voice", "upload cancelled — preserved", ["id": id])
            return .cancelled
        } catch {
            errorMessage = "\(Self.diagnosticMessage(prefix: "Transcription failed", error)) — recording saved"
            store.preserve(id: id, reason: "transcribe-failed")
            var meta = Self.diagnosticMeta(error)
            meta["id"] = id
            AppLog.error("voice", "transcribe failed — preserved", meta)
            return .failed
        }
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
        store.preserve(id: id, reason: "recording")
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

    func resumeForForeground() {}
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
