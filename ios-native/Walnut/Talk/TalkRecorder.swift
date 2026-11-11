import AVFoundation
import Foundation

/// What a take came to.
enum TalkTake: Equatable {
    case words(String, recordingID: String?)
    /// The engine heard the audio and found no words in it.
    case noWords(recordingID: String?)
    /// No words yet: the audio is kept (`recordingID`) and the sentence says why.
    case failed(String, recordingID: String?)
}

/// The microphone side of Talk to Walnut, a seam so the unit tests drive the
/// session without a microphone or a server.
@MainActor
protocol TalkRecording: AnyObject {
    /// Start a take. Nil when it started; else why it could not.
    func begin() async -> String?
    /// The live loudness in dBFS; nil while nothing records, which while a take
    /// should be live means it was stopped under it (a call, a media reset).
    func level() -> Float?
    /// Stop the take and transcribe it.
    func finish() async -> TalkTake
    /// Stop the take and delete it.
    func discard()
    /// Transcribe a kept take again.
    func transcribe(recordingID: String) async -> TalkTake
    /// Delete a kept take the person discarded (or that had no words).
    func forget(recordingID: String)
    /// Kept takes of this surface still waiting for words, oldest first: a take
    /// a dead process or an interruption left behind.
    func keptTakeIDs() -> [String]
    /// A kept take's audio, to play it back and to say how long it is, so the
    /// person can tell one unsent recording from another.
    func keptAudio(recordingID: String) -> TalkKeptAudio?
}

/// A kept take's audio file and its length (nil when unknown).
struct TalkKeptAudio: Equatable {
    let url: URL
    let seconds: Double?
    /// When the recording began.
    var recordedAt: Date?
}

/// The app's own voice recorder (the chat mic's: the take goes straight to disk,
/// uploads while it records, and the paired server transcribes it), on its own
/// surface so no composer offers these takes for a retry.
@MainActor
final class VoiceTalkRecorder: TalkRecording {
    private let store: VoiceRecordingStore
    private lazy var recorder: VoiceRecorder = {
        let recorder = VoiceRecorder(store: store)
        recorder.surface = VoiceRecorder.talkSurface
        return recorder
    }()
    /// The take this recorder started, kept past an interruption that stops it.
    private var takeID: String?

    init(store: VoiceRecordingStore = .shared) {
        self.store = store
    }

    func begin() async -> String? {
        // A retry of earlier takes (the foreground drain) owns the recorder now.
        guard recorder.state == .idle else { return "Walnut is still finishing your last recording. Try again in a moment." }
        takeID = nil
        var started: Bool
        #if DEBUG
        if let path = TalkDebug.replayFile {
            // The file stands in for the microphone's sound only: the session is
            // switched on as a real take does it (build 160 shipped a session that
            // a test's own session hid).
            AppLog.info("talk", "replaying a file as the microphone", ["file": (path as NSString).lastPathComponent])
            if let refused = await recorder.activateForReplay() { return refused }
            started = recorder._beginReplayTake(source: URL(fileURLWithPath: path))
            if !started { return recorder.errorMessage ?? "Could not replay the test recording." }
            takeID = recorder.liveTakeID
            return nil
        }
        #endif
        started = await recorder.start()
        guard started else { return recorder.errorMessage ?? "Couldn't start the microphone." }
        takeID = recorder.liveTakeID
        return nil
    }

    func level() -> Float? { recorder.liveLevel() }

    func finish() async -> TalkTake {
        let id = takeID
        takeID = nil
        guard recorder.liveTakeID != nil, recorder.liveTakeID == id else {
            // Stopped under us: the recorder kept the audio (preserveAndStop).
            return .failed("The recording was cut off (a call, or another app took the microphone).", recordingID: id)
        }
        let words = await recorder.stopAndTranscribe()
        return take(words: words, recordingID: id)
    }

    func discard() {
        takeID = nil
        recorder.cancel()
    }

    func transcribe(recordingID: String) async -> TalkTake {
        let words = await recorder.transcribeKept(id: recordingID)
        return take(words: words, recordingID: recordingID)
    }

    func forget(recordingID: String) {
        store.discard(id: recordingID)
    }

    func keptAudio(recordingID: String) -> TalkKeptAudio? {
        guard let kept = store.recording(id: recordingID), kept.audioAvailable,
              FileManager.default.fileExists(atPath: kept.audioURL.path) else { return nil }
        var seconds = kept.durationSeconds
        if seconds == nil, let file = try? AVAudioFile(forReading: kept.audioURL), file.processingFormat.sampleRate > 0 {
            seconds = Double(file.length) / file.processingFormat.sampleRate
        }
        return TalkKeptAudio(url: kept.audioURL, seconds: seconds, recordedAt: kept.createdAt)
    }

    func keptTakeIDs() -> [String] {
        let live = recorder.liveTakeID
        return store.pending()
            .filter { $0.surface == VoiceRecorder.talkSurface && $0.id != live }
            .sorted { $0.createdAt < $1.createdAt }
            .map(\.id)
    }

    private func take(words: String?, recordingID: String?) -> TalkTake {
        let failure = recordingID.flatMap { store.recording(id: $0) }?.lastErrorKind
        return Self.take(words: words, recordingID: recordingID, error: recorder.errorMessage, failure: failure)
    }

    static func take(
        words: String?, recordingID: String?, error: String?, failure: VoiceRetryPlan.FailureKind? = nil
    ) -> TalkTake {
        guard let words else {
            if failure == .empty { return .noWords(recordingID: recordingID) }
            return .failed(reason(failure: failure, error: error), recordingID: recordingID)
        }
        let trimmed = words.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? .noWords(recordingID: recordingID) : .words(trimmed, recordingID: recordingID)
    }

    /// Why a take has no words yet, said so the person knows what to fix. The
    /// unsent row itself shows the recording is kept, so this never repeats it.
    static func reason(failure: VoiceRetryPlan.FailureKind?, error: String?) -> String {
        switch failure {
        case .transport:
            return TalkReason.serverUnavailable
        case .cancelled:
            return TalkReason.uploadCut
        case .damaged:
            return "This recording is damaged and can't be turned into text."
        default:
            guard let text = error, !text.isEmpty else { return "Couldn't turn the recording into text." }
            return TalkReason.short(text)
        }
    }
}

#if DEBUG
/// DEBUG hooks for driving Talk to Walnut on a simulator, where there is no
/// voice to speak into the microphone. Set with
/// `simctl spawn <udid> defaults write dev.openwalnut.ios <key> <value>`, so
/// they reach the app however iOS starts it (an intent run from the Shortcuts
/// app gets no launch arguments).
enum TalkDebug {
    static let replayFileKey = "walnut.debug.talkReplayFile"

    /// A 16 kHz mono 16-bit PCM CAF file the take plays as its microphone.
    static var replayFile: String? {
        guard let path = UserDefaults.standard.string(forKey: replayFileKey), !path.isEmpty,
              FileManager.default.fileExists(atPath: path) else { return nil }
        return path
    }

    static let refuseFromBehindKey = "walnut.debug.talkRefuseFromBehind"

    /// The simulator records from behind the app on screen whatever the order; a phone
    /// may still refuse. True: a take started from behind is refused the way a phone
    /// refused build 160's, so a test walks the press that opens Walnut instead.
    static var refuseFromBehind: Bool { UserDefaults.standard.bool(forKey: refuseFromBehindKey) }
}
#endif

#if DEBUG
/// A capture that plays a recorded file in real time and reports its loudness,
/// for `VoiceRecorder._beginReplayTake`.
///
/// Its loudness follows the readings, not the wall clock: each reading moves on by
/// the time since the last one, at most `maxStep`. A reader that was held up (the
/// first take on a loaded CI runner) still walks through the whole file, where a
/// wall clock had run past its end unheard and the take was dropped as silence.
final class TalkReplayCapture: AudioCapture, AudioLevelSource {
    /// The most one reading moves on: about two of the Talk monitor's ticks.
    static let maxStep: TimeInterval = 0.25
    private let samples: [Int16]
    private let rate: Double
    private let now: () -> Date
    private let began: Date
    private var stoppedAt: TimeInterval?
    /// How far into the file the readings have come, and when the last one was.
    private var played: TimeInterval = 0
    private var lastRead: Date?
    /// A real recording of the microphone, thrown away, that holds the session
    /// the take switched on (`VoiceRecorder.activateForReplay`) as a real take
    /// does: without one iOS suspends a Walnut the person left mid-take.
    private let keepAlive: AVAudioRecorder?
    private let keepAliveURL: URL

    init?(url: URL) {
        guard let file = try? AVAudioFile(forReading: url, commonFormat: .pcmFormatInt16, interleaved: true),
              let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
              (try? file.read(into: buffer)) != nil, let data = buffer.int16ChannelData else { return nil }
        samples = Array(UnsafeBufferPointer(start: data[0], count: Int(buffer.frameLength)))
        rate = file.processingFormat.sampleRate
        now = Date.init
        began = Date()
        keepAliveURL = FileManager.default.temporaryDirectory.appendingPathComponent("talk-replay-hold-\(UUID().uuidString).caf")
        keepAlive = try? AVAudioRecorder(url: keepAliveURL, settings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
        ])
        keepAlive?.record()
    }

    /// Test seam: these samples, this clock, and no session to hold.
    init(samples: [Int16], rate: Double, now: @escaping () -> Date) {
        self.samples = samples
        self.rate = rate
        self.now = now
        began = now()
        keepAlive = nil
        keepAliveURL = FileManager.default.temporaryDirectory.appendingPathComponent("talk-replay-none")
    }

    deinit {
        keepAlive?.stop()
        try? FileManager.default.removeItem(at: keepAliveURL)
    }

    var currentTime: TimeInterval { stoppedAt ?? now().timeIntervalSince(began) }

    func stop() {
        if stoppedAt == nil { stoppedAt = now().timeIntervalSince(began) }
        keepAlive?.stop()
        try? FileManager.default.removeItem(at: keepAliveURL)
    }

    /// RMS of the 50 ms before where the readings have come; silence past the end.
    var level: Float {
        let at = now()
        if stoppedAt == nil, let last = lastRead {
            played += min(max(0, at.timeIntervalSince(last)), Self.maxStep)
        }
        lastRead = at
        let end = Int(played * rate)
        let start = max(0, end - Int(rate * 0.05))
        guard end <= samples.count, end > start else { return -160 }
        var sum: Double = 0
        for sample in samples[start..<end] {
            let value = Double(sample) / Double(Int16.max)
            sum += value * value
        }
        let rms = (sum / Double(end - start)).squareRoot()
        return rms > 0 ? Float(20 * log10(rms)) : -160
    }
}
#endif
