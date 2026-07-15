import AVFoundation
import Observation

/// Voice-input recorder: mic → m4a (AAC 16kHz mono) → server transcription.
/// The server routes to the best engine (Mac whisper via bridge when
/// reachable, OpenAI Whisper as the cloud fallback) — the phone just uploads.
/// NSObject base is required for AVAudioRecorderDelegate conformance below.
@Observable
@MainActor
final class VoiceRecorder: NSObject {
    enum State: Equatable {
        case idle
        case recording
        case transcribing
    }

    private(set) var state: State = .idle
    private(set) var elapsed: TimeInterval = 0
    var errorMessage: String?

    private var recorder: AVAudioRecorder?
    private var tickTask: Task<Void, Never>?
    private var fileURL: URL?
    private let api = WalnutAPI()

    /// ~90s of speech is plenty for a chat message and keeps the upload well
    /// under the bridge relay frame cap.
    private static let maxSeconds: TimeInterval = 90

    // MARK: - Recording

    /// Ask permission and start capturing. Returns false when the mic is
    /// unavailable (permission denied / session failure) — the caller shows
    /// `errorMessage`.
    func start() async -> Bool {
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
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("voice-\(UUID().uuidString).m4a")
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
            recorder = rec
            fileURL = url
            elapsed = 0
            state = .recording
            startTicker()
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
        var lastError: NSError?
        for attempt in 0...2 {
            do {
                if attempt < 2 {
                    try session.setCategory(.record, mode: .default, options: .allowBluetoothHFP)
                } else {
                    try session.setCategory(.record, mode: .default)
                }
                try session.setActive(true)
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
    /// on failure (with `errorMessage` set). The recording file is deleted
    /// either way.
    func stopAndTranscribe() async -> String? {
        guard state == .recording, let url = fileURL else { return nil }
        stopCapture()
        state = .transcribing
        defer {
            state = .idle
            try? FileManager.default.removeItem(at: url)
            fileURL = nil
        }
        do {
            let data = try Data(contentsOf: url)
            guard data.count > 1_000 else {
                errorMessage = "Recording too short"
                return nil
            }
            let text = try await api.transcribe(audio: data, format: "m4a")
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                errorMessage = "No speech recognized"
                return nil
            }
            AppLog.info("voice", "transcribed", ["chars": "\(trimmed.count)", "bytes": "\(data.count)"])
            return trimmed
        } catch let error as APIError {
            errorMessage = error.voiceNotice
            AppLog.error("voice", "transcribe failed", ["error": error.localizedDescription])
            return nil
        } catch {
            errorMessage = Self.diagnosticMessage(prefix: "Transcription failed", error)
            AppLog.error("voice", "transcribe failed", Self.diagnosticMeta(error))
            return nil
        }
    }

    /// Discard the current recording without transcribing.
    func cancel() {
        guard state == .recording else { return }
        stopCapture()
        if let url = fileURL { try? FileManager.default.removeItem(at: url) }
        fileURL = nil
        state = .idle
    }

    // MARK: - Internals

    private func stopCapture() {
        tickTask?.cancel()
        tickTask = nil
        recorder?.stop()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func startTicker() {
        tickTask?.cancel()
        tickTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(0.5))
                guard let self, self.state == .recording else { return }
                self.elapsed = self.recorder?.currentTime ?? self.elapsed + 0.5
                if self.elapsed >= Self.maxSeconds {
                    // Auto-stop at the cap — the partial take still transcribes.
                    self.errorMessage = nil
                    _ = await self.stopAndTranscribeIntoHandler()
                    return
                }
            }
        }
    }

    /// Auto-stop path: the composer registers a handler to receive text from
    /// cap-triggered stops (a manual stop returns text directly instead).
    var onAutoStopText: ((String) -> Void)?

    private func stopAndTranscribeIntoHandler() async -> Bool {
        guard let text = await stopAndTranscribe() else { return false }
        onAutoStopText?(text)
        return true
    }

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

extension VoiceRecorder: AVAudioRecorderDelegate {
    /// Encode failures happen mid-recording with no throw site to catch —
    /// without this delegate they were entirely silent (state stuck on
    /// `.recording` until the user manually stopped a dead recorder).
    nonisolated func audioRecorderEncodeErrorDidOccur(_ audioRecorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor in
            self.stopCapture()
            if let url = self.fileURL { try? FileManager.default.removeItem(at: url) }
            self.fileURL = nil
            self.state = .idle
            let error = error ?? NSError(domain: NSOSStatusErrorDomain, code: 0)
            self.errorMessage = Self.diagnosticMessage(prefix: "Recording failed", error)
            AppLog.error("voice", "encode error", Self.diagnosticMeta(error))
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
