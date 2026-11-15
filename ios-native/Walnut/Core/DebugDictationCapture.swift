#if DEBUG && targetEnvironment(simulator)
import Foundation

/// A UI-test take with no audio session, microphone or playback. It drives the
/// real recorder's stop, persistence, retry and Send paths with test-hook words.
private final class DebugDictationCapture: AudioCapture {
    private let began = Date()
    private var stoppedAt: TimeInterval?
    var currentTime: TimeInterval { stoppedAt ?? Date().timeIntervalSince(began) }
    func stop() { stoppedAt = currentTime }
}

extension VoiceRecorder {
    var isSilentUITestDictation: Bool { silentUITestWords != nil }

    private var silentUITestWords: String? {
        let defaults = UserDefaults.standard
        guard ProcessInfo.processInfo.arguments.contains("-walnut.uiTestKeychain"),
              defaults.bool(forKey: "walnut.silentAudio"),
              let words = defaults.string(forKey: "walnut.debug.dictationText"), !words.isEmpty else { return nil }
        return words
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

    /// Only an isolated, silent simulator UI test can opt into the fake capture.
    /// Release builds and normal simulator launches cannot enter this path.
    func beginSilentUITestTake() -> Bool? {
        let defaults = UserDefaults.standard
        guard silentUITestWords != nil else { return nil }
        guard state == .idle else { return false }
        errorMessage = nil
        if defaults.bool(forKey: "walnut.debug.dictationDenied") {
            errorMessage = Self.microphoneDeniedMessage
            return false
        }
        let id = UUID().uuidString
        let url = store.newRecordingURL(id: id)
        do {
            // Test bytes only, never sent to an engine: uploadOverride below
            // replaces the upload, just as the recorder unit tests do.
            try Data(repeating: 0xAB, count: 4_000).write(to: url)
        } catch {
            errorMessage = "Could not create the test recording."
            return false
        }
        prepareSilentUITestTranscription()
        _testBeginTake(capture: DebugDictationCapture(), url: url, id: id)
        AppLog.info("voice", "silent UI-test dictation began", ["surface": surface])
        return true
    }
}
#endif
