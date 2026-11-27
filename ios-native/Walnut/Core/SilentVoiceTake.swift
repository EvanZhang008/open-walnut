import AVFoundation

/// The capture of a take while `AudioSilence` is on (every UI test, the Simulator, an
/// agent's run): no audio session, microphone or output opens. The Simulator runs even a
/// record-only take through the Mac's own audio device, output included, so a real
/// recorder there made the app an audio output on a Mac with a person at it (2026-11-26).
///
/// The file is what a real take writes, 16 kHz mono 16-bit PCM CAF of silence, by plain
/// file writes: half a second when the take starts, padded to the take's whole length when
/// it stops (not grown while it runs), so the final upload, retry and history all handle a
/// real recording. Its level is true silence, as a recorder's meters read in a quiet room,
/// so Talk and hands-free voice mode hear a take that is running and quiet, not one that
/// was cut off.
final class SilentVoiceCapture: AudioCapture, AudioLevelSource {
    /// dBFS of silence (`AudioLevelSource`).
    let level: Float = -160
    private let began = Date()
    private var stoppedAt: TimeInterval?
    private var file: AVAudioFile?
    private var written: AVAudioFramePosition = 0

    init?(url: URL) {
        guard let file = try? AVAudioFile(forWriting: url, settings: VoiceRecorder.captureSettings,
                                          commonFormat: .pcmFormatInt16, interleaved: true) else { return nil }
        self.file = file
        fill(through: 0.5)
    }

    var currentTime: TimeInterval { stoppedAt ?? Date().timeIntervalSince(began) }

    func stop() {
        guard stoppedAt == nil else { return }
        let length = currentTime
        stoppedAt = length
        fill(through: length)
        // Releasing the file writes its final header.
        file = nil
    }

    /// Silence up to `seconds` into the take.
    private func fill(through seconds: TimeInterval) {
        guard let file else { return }
        let format = file.processingFormat
        let target = AVAudioFramePosition(seconds * format.sampleRate)
        while written < target {
            let count = AVAudioFrameCount(min(target - written, AVAudioFramePosition(format.sampleRate)))
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count) else { return }
            buffer.frameLength = count
            // A new buffer's samples are not promised to be zero.
            if let samples = buffer.int16ChannelData {
                samples[0].initialize(repeating: 0, count: Int(count))
            }
            guard (try? file.write(from: buffer)) != nil else { return }
            written += AVAudioFramePosition(count)
        }
    }
}

#if DEBUG && targetEnvironment(simulator)
/// UI-test words for a silent take: an isolated UI test launch names the words its take
/// "heard", and the upload is replaced by them, just as the recorder unit tests do.
/// Release builds and normal Simulator launches never enter this.
extension VoiceRecorder {
    private var silentUITestWords: String? {
        let defaults = UserDefaults.standard
        guard ProcessInfo.processInfo.arguments.contains("-walnut.uiTestKeychain"),
              defaults.bool(forKey: "walnut.silentAudio"),
              let words = defaults.string(forKey: "walnut.debug.dictationText"), !words.isEmpty else { return nil }
        return words
    }

    /// A UI test's denied microphone, with no system alert to answer.
    var debugDictationDenied: Bool {
        silentUITestWords != nil && UserDefaults.standard.bool(forKey: "walnut.debug.dictationDenied")
    }

    /// Also installs on a reopened field, so a preserved test take never reaches
    /// a real engine when the ordinary recovery lifecycle drains it.
    func prepareSilentUITestTranscription() {
        guard uploadOverride == nil, let words = silentUITestWords else { return }
        let defaults = UserDefaults.standard
        let delay = max(0, defaults.double(forKey: "walnut.debug.dictationDelay"))
        var failOnce = defaults.bool(forKey: "walnut.debug.dictationFailOnce")
        uploadOverride = { _ in
            if delay > 0 { try await Task.sleep(for: .seconds(delay)) }
            if failOnce {
                failOnce = false
                throw URLError(.notConnectedToInternet)
            }
            return words
        }
    }
}
#endif
