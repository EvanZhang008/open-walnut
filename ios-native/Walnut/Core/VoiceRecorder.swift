import AVFoundation
import Observation

/// Voice-input recorder: mic → m4a (AAC 16kHz mono) → server transcription.
/// The server routes to the best engine (Mac whisper via bridge when
/// reachable, OpenAI Whisper as the cloud fallback) — the phone just uploads.
@Observable
@MainActor
final class VoiceRecorder {
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
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.record, mode: .spokenAudio)
            try audioSession.setActive(true)

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
            errorMessage = "Recording failed: \(error.localizedDescription)"
            AppLog.error("voice", "record start failed", ["error": error.localizedDescription])
            return false
        }
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
            errorMessage = "Transcription failed: \(error.localizedDescription)"
            AppLog.error("voice", "transcribe failed", ["error": error.localizedDescription])
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
