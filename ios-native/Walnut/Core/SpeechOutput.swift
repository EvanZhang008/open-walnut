import AVFoundation
import Observation

/// Voice mode's speaker: the system's own text-to-speech, on the phone.
///
/// On-device on purpose. It costs nothing per answer, works with the Mac asleep
/// and the phone offline, and reads Chinese and English. A downloaded "Enhanced"
/// or "Premium" voice (Settings > Accessibility > Spoken Content) is picked up
/// automatically when there is one for the answer's language.
///
/// Audio session: `.playback` + `.spokenAudio`, ducking other audio (music dips,
/// then comes back). `.playback` also plays with the silent switch on, which is
/// right here: the person turned voice mode on to hear the answer. The recorder
/// uses the same shared session for `.record`, so every switch-off goes through
/// `AudioSessionHandoff`, and a stop made to hand the session to the recorder
/// (`stop(handoff: true)`) does not queue a switch-off the recorder would lose.
@Observable
@MainActor
final class SpeechOutput: NSObject {
    /// One voice at a time in the whole app.
    static let shared = SpeechOutput()

    /// The id of what is being spoken (voice mode passes the message id), nil
    /// when silent.
    private(set) var speakingID: String?
    var isSpeaking: Bool { speakingID != nil }

    @ObservationIgnored private let synthesizer = AVSpeechSynthesizer()
    /// The next delegate callback ends a stop that handed the session to the
    /// recorder: it must not switch the session off under the new recording.
    @ObservationIgnored private var handingOff = false
    /// Spoken utterances by object identity, so a late callback for an
    /// utterance that was replaced cannot clear the newer one's state.
    @ObservationIgnored private var current: AVSpeechUtterance?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    /// Speak `text` in `language`, replacing anything already being said.
    func speak(_ text: String, language: String, id: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if synthesizer.isSpeaking {
            handingOff = true
            synthesizer.stopSpeaking(at: .immediate)
        }
        await AudioSessionHandoff.settle()
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
        } catch {
            AppLog.warn("voice-mode", "speaker could not take the audio session", [
                "error": String(describing: error),
            ])
            return
        }
        let utterance = AVSpeechUtterance(string: trimmed)
        utterance.voice = Self.voice(for: language)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        utterance.postUtteranceDelay = 0.1
        handingOff = false
        current = utterance
        speakingID = id
        synthesizer.speak(utterance)
        AppLog.info("voice-mode", "speaking", [
            "id": id, "language": language, "voice": utterance.voice?.identifier ?? "default",
            "chars": String(trimmed.count),
        ])
    }

    /// Stop now. `handoff`: the recorder is about to take the session, so leave
    /// switching it off to the recorder.
    func stop(handoff: Bool = false) {
        guard synthesizer.isSpeaking || speakingID != nil else { return }
        handingOff = handoff
        current = nil
        speakingID = nil
        synthesizer.stopSpeaking(at: .immediate)
    }

    /// The best installed voice for the language: Premium, then Enhanced, then the
    /// system's default for it. Novelty and Personal Voice entries are skipped.
    static func voice(for language: String) -> AVSpeechSynthesisVoice? {
        let base = String(language.prefix(2))
        let usable = AVSpeechSynthesisVoice.speechVoices().filter {
            !$0.voiceTraits.contains(.isNoveltyVoice) && !$0.voiceTraits.contains(.isPersonalVoice)
        }
        let exact = usable.filter { $0.language == language }
        let pool = exact.isEmpty ? usable.filter { $0.language.hasPrefix(base) } : exact
        if let best = pool.max(by: { $0.quality.rawValue < $1.quality.rawValue }),
           best.quality.rawValue > AVSpeechSynthesisVoiceQuality.default.rawValue {
            return best
        }
        return AVSpeechSynthesisVoice(language: language) ?? pool.first
    }

    private func finished(_ utterance: AVSpeechUtterance) {
        // A callback for an utterance that is no longer current (it was replaced
        // or stopped) only matters for the session switch-off.
        if utterance === current {
            current = nil
            speakingID = nil
        }
        if handingOff {
            handingOff = false
            return
        }
        guard !synthesizer.isSpeaking else { return }
        AudioSessionHandoff.deactivateOffMain()
    }
}

extension SpeechOutput: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.finished(utterance) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.finished(utterance) }
    }
}
