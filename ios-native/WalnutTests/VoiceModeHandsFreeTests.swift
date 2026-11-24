import AVFoundation
import UIKit
import XCTest
@testable import Walnut

/// Hands-free voice mode (the user, 2026-11-23: "once I tap voice mode I don't need any
/// tap: it detects my pause, sends, and when it is done it answers me"): it listens on
/// its own, a pause after speech sends the take, the answer is read, and it listens
/// again. The microphone is a fake capture whose loudness the test sets; the words come
/// from the recorder's upload seam.
@MainActor
final class VoiceModeHandsFreeTests: XCTestCase {
    private var tempDir: URL!
    private var store: VoiceRecordingStore!

    override func setUp() async throws {
        try await super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("hands-free-tests-\(UUID().uuidString)", isDirectory: true)
        store = VoiceRecordingStore(baseDir: tempDir)
        VoiceRecordingStore._testResetDrainGate()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tempDir)
        VoiceRecordingStore._testResetDrainGate()
        try await super.tearDown()
    }

    // MARK: - Rig

    /// A microphone whose loudness the test sets.
    private final class LoudCapture: AudioCapture, AudioLevelSource {
        var currentTime: TimeInterval = 2
        var level: Float = -70
        func stop() {}
    }

    /// Says nothing; "reads" until the test ends the reading.
    @MainActor
    private final class Speaker: VoiceSpeaker {
        private(set) var said: [String] = []
        private(set) var speakingID: String?
        var isSpeaking: Bool { speakingID != nil }
        func speak(_ text: String, language: String, id: String) async {
            said.append(id)
            speakingID = id
        }
        func stop(handoff: Bool) { speakingID = nil }
        func finish() { speakingID = nil }
    }

    @MainActor
    private final class App {
        var active = true
        let center = NotificationCenter()
        func leave() {
            active = false
            center.post(name: UIApplication.willResignActiveNotification, object: nil)
        }
        func comeBack() {
            active = true
            center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        }
    }

    private final class Rig {
        let voice: VoiceModeController
        let speaker: Speaker
        let app: App
        var mics: [LoudCapture] = []
        var sent: [String] = []
        var words = "Turn on the lights"
        /// How long the mic takes to open.
        var openDelay: Duration = .zero
        var mic: LoudCapture { mics.last! }
        init(voice: VoiceModeController, speaker: Speaker, app: App) {
            self.voice = voice
            self.speaker = speaker
            self.app = app
        }
    }

    private func row(_ id: String, _ role: String, _ text: String) -> ChatMessage {
        ChatMessage(id: id, role: role, text: text, createdAt: "2026-11-23T10:00:00Z", kind: nil)
    }

    private func rig(handsFree: Bool = true, rows: [ChatMessage] = []) -> Rig {
        let recorder = VoiceRecorder(store: store)
        let speaker = Speaker()
        let app = App()
        var sendBox: ((String) -> Void)?
        let voice = VoiceModeController(
            sessionID: "hands-free", rows: rows, recorder: recorder, speaker: speaker, handsFree: handsFree,
            liveWords: VoiceLiveWords(draft: { _ in "" }),
            isAppActive: { app.active }, notifications: app.center
        ) { text in
            sendBox?(text)
            return true
        }
        voice.pauseToSendSeconds = 0.4
        voice.quietPauseSeconds = 1.5
        let rig = Rig(voice: voice, speaker: speaker, app: app)
        sendBox = { [weak rig] in rig?.sent.append($0) }
        recorder.uploadOverride = { [weak rig] _ in rig?.words ?? "" }
        let store = self.store!
        voice.micOpener = { [weak rig, weak recorder] in
            guard let rig, let recorder else { return false }
            if rig.openDelay > .zero { try? await Task.sleep(for: rig.openDelay) }
            let id = UUID().uuidString
            let url = store.newRecordingURL(id: id)
            try? Data(repeating: 0, count: 4_000).write(to: url)
            let capture = LoudCapture()
            rig.mics.append(capture)
            recorder._testBeginTake(capture: capture, url: url, id: id)
            return true
        }
        return rig
    }

    private func waitUntil(_ what: String, seconds: Double = 5, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("timed out waiting for \(what)")
    }

    /// Speech, then quiet: the take a person says and stops.
    private func say(_ rig: Rig) async {
        rig.mic.level = -20
        try? await Task.sleep(for: .milliseconds(500))
        rig.mic.level = -70
    }

    // MARK: - The loop

    func testOnTapItListensAtOnceAndAPauseAfterSpeechSendsTheWords() async {
        let r = rig()
        defer { r.voice.shutDown() }
        r.voice.begin()
        await waitUntil("listening") { r.voice.phase == .listening }
        XCTAssertEqual(r.mics.count, 1, "voice mode did not open the mic on its own")
        await say(r)
        await waitUntil("the take sent") { r.sent == ["Turn on the lights"] }
        XCTAssertEqual(r.voice.phase, .waiting, "after the send it waits for the answer")
        XCTAssertEqual(r.mics.count, 1, "the mic opened again before the answer came")
    }

    func testTheAnswerIsReadAndThenItListensAgainWithNoTap() async {
        let before = [row("u0", "user", "Hi"), row("a0", "assistant", "Hello.")]
        let r = rig(rows: before)
        defer { r.voice.shutDown() }
        r.voice.begin()
        await waitUntil("listening") { r.voice.phase == .listening }
        await say(r)
        await waitUntil("sent") { !r.sent.isEmpty }
        let answer = row("a1", "assistant", "The lights are on.")
        r.voice.observe(rows: before + [row("u1", "user", "Turn on the lights"), answer], streaming: false)
        await waitUntil("the answer read") { r.speaker.said == ["a1"] }
        XCTAssertEqual(r.voice.phase, .speaking)
        XCTAssertEqual(r.mics.count, 1, "the mic opened over the answer being read")
        r.speaker.finish()
        await waitUntil("listening again") { r.voice.phase == .listening && r.mics.count == 2 }
        // And the second round goes out the same way.
        r.words = "And the kitchen"
        await say(r)
        await waitUntil("the second take sent") { r.sent == ["Turn on the lights", "And the kitchen"] }
    }

    func testATurnThatEndsWithNothingToReadListensAgain() async {
        let r = rig(rows: [row("a0", "assistant", "Hello.")])
        defer { r.voice.shutDown() }
        r.voice.begin()
        await waitUntil("listening") { r.voice.phase == .listening }
        await say(r)
        await waitUntil("sent") { !r.sent.isEmpty }
        let asked = row("u1", "user", "Turn on the lights")
        r.voice.observe(rows: [row("a0", "assistant", "Hello."), asked], streaming: true)
        r.voice.observe(rows: [row("a0", "assistant", "Hello."), asked], streaming: false)
        await waitUntil("listening again") { r.voice.phase == .listening && r.mics.count == 2 }
        XCTAssertEqual(r.speaker.said, [], "nothing was there to read")
    }

    func testStopWhileReadingListens() async {
        let r = rig()
        defer { r.voice.shutDown() }
        r.voice.begin()
        await waitUntil("listening") { r.voice.phase == .listening }
        await say(r)
        await waitUntil("sent") { !r.sent.isEmpty }
        r.voice.observe(rows: [row("u1", "user", "Turn on the lights"), row("a1", "assistant", "Done.")], streaming: false)
        await waitUntil("reading") { r.voice.phase == .speaking }
        r.voice.stopSpeaking()
        await waitUntil("listening after Stop") { r.voice.phase == .listening && r.mics.count == 2 }
    }

    // MARK: - Pausing

    func testATapBeforeAnyWordsPausesAndATapListensAgain() async {
        let r = rig()
        defer { r.voice.shutDown() }
        r.voice.begin()
        await waitUntil("listening") { r.voice.phase == .listening }
        await r.voice.micTapped()
        XCTAssertEqual(r.voice.phase, .ready)
        XCTAssertTrue(r.voice.pausedByPerson, "a tap with nothing said pauses")
        try? await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(r.mics.count, 1, "a paused voice mode opened the mic on its own")
        XCTAssertEqual(r.sent, [])
        await r.voice.micTapped()
        await waitUntil("listening again") { r.voice.phase == .listening && r.mics.count == 2 }
        XCTAssertFalse(r.voice.pausedByPerson)
    }

    func testATapAfterWordsSendsThemAtOnce() async {
        let r = rig()
        defer { r.voice.shutDown() }
        r.voice.pauseToSendSeconds = 30
        r.voice.begin()
        await waitUntil("listening") { r.voice.phase == .listening }
        r.mic.level = -20
        await waitUntil("speech heard") { r.voice.takeHeardSpeech }
        await r.voice.micTapped()
        await waitUntil("sent") { r.sent == ["Turn on the lights"] }
    }

    func testAQuietStretchPausesListening() async {
        let r = rig()
        defer { r.voice.shutDown() }
        r.voice.begin()
        await waitUntil("listening") { r.voice.phase == .listening }
        await waitUntil("paused after the quiet", seconds: 4) { r.voice.pausedByPerson }
        XCTAssertEqual(r.voice.phase, .ready)
        XCTAssertEqual(r.sent, [], "a quiet take sent something")
        XCTAssertEqual(r.mics.count, 1)
    }

    func testATakeWithNoWordsInItListensOn() async {
        let r = rig()
        defer { r.voice.shutDown() }
        r.words = ""
        r.voice.begin()
        await waitUntil("listening") { r.voice.phase == .listening }
        await say(r)
        await waitUntil("listening on") { r.mics.count == 2 && r.voice.phase == .listening }
        XCTAssertEqual(r.sent, [])
        XCTAssertNil(r.voice.notice)
    }

    // MARK: - Answers that come on their own, and leaving Walnut

    func testAnAnswerThatComesWhileNobodySpeaksIsReadThenItListens() async {
        let before = [row("a0", "assistant", "I handed it to the test task.")]
        let r = rig(rows: before)
        defer { r.voice.shutDown() }
        r.voice.begin()
        await waitUntil("listening") { r.voice.phase == .listening }
        // The task it handed work to finished: a new turn on its own.
        r.voice.observe(rows: before + [row("a1", "assistant", "The tests passed.")], streaming: false)
        await waitUntil("read") { r.speaker.said == ["a1"] }
        XCTAssertEqual(r.sent, [], "the quiet take was sent")
        r.speaker.finish()
        await waitUntil("listening again") { r.voice.phase == .listening && r.mics.count == 2 }
    }

    func testAnAnswerThatComesWhileThePersonTalksWaitsForReplay() async {
        let before = [row("a0", "assistant", "I handed it to the test task.")]
        let r = rig(rows: before)
        defer { r.voice.shutDown() }
        r.voice.pauseToSendSeconds = 30
        r.voice.begin()
        await waitUntil("listening") { r.voice.phase == .listening }
        r.mic.level = -20
        await waitUntil("speech heard") { r.voice.takeHeardSpeech }
        r.voice.observe(rows: before + [row("a1", "assistant", "The tests passed.")], streaming: false)
        try? await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(r.speaker.said, [], "the answer was read over the person's words")
        XCTAssertEqual(r.voice.phase, .listening)
        XCTAssertEqual(r.voice.lastAnswer?.id, "a1", "the answer is kept for Replay")
    }

    func testAnAnswerThatEndsWhileTheMicOpensIsReadOnceItIsOpenAndNotLost() async {
        let before = [row("a0", "assistant", "I handed it to the test task.")]
        let r = rig(rows: before)
        defer { r.voice.shutDown() }
        r.openDelay = .milliseconds(400)
        r.voice.begin()
        try? await Task.sleep(for: .milliseconds(100))
        r.voice.observe(rows: before + [row("a1", "assistant", "The tests passed.")], streaming: false)
        XCTAssertEqual(r.speaker.said, [], "the answer took the audio while the mic was opening")
        await waitUntil("read once the mic opened") { r.speaker.said == ["a1"] }
        XCTAssertNotEqual(r.voice.recorder.state, .recording, "the quiet take did not give way to the answer")
        r.speaker.finish()
        await waitUntil("listening again") { r.voice.phase == .listening && r.mics.count == 2 }
    }

    func testAPermissionCardWhileTheMicOpensDoesNotSpeakOverIt() async {
        let r = rig()
        defer { r.voice.shutDown() }
        r.openDelay = .milliseconds(400)
        r.voice.begin()
        try? await Task.sleep(for: .milliseconds(100))
        await r.voice.announceWaitingOnYou(requestIDs: ["perm-1"])
        XCTAssertEqual(r.speaker.said, [], "the card was announced while the mic was opening")
        await waitUntil("listening") { r.voice.phase == .listening }
    }

    func testLeavingWalnutDropsAQuietTakeAndItListensOnReturn() async {
        let r = rig()
        defer { r.voice.shutDown() }
        r.voice.begin()
        await waitUntil("listening") { r.voice.phase == .listening }
        r.app.leave()
        await waitUntil("mic closed") { r.voice.phase == .ready }
        try? await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(r.mics.count, 1, "it listened while Walnut was away")
        r.app.comeBack()
        await waitUntil("listening on return") { r.voice.phase == .listening && r.mics.count == 2 }
    }

    func testLeavingWalnutMidSentenceSendsWhatWasSaid() async {
        let r = rig()
        defer { r.voice.shutDown() }
        r.voice.pauseToSendSeconds = 30
        r.voice.begin()
        await waitUntil("listening") { r.voice.phase == .listening }
        r.mic.level = -20
        await waitUntil("speech heard") { r.voice.takeHeardSpeech }
        r.app.leave()
        await waitUntil("sent") { r.sent == ["Turn on the lights"] }
    }

    func testWithTheExperimentOffVoiceModeStillWaitsForATap() async {
        let r = rig(handsFree: false)
        defer { r.voice.shutDown() }
        r.voice.begin()
        try? await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(r.voice.phase, .ready)
        XCTAssertEqual(r.mics.count, 0, "voice mode opened the mic with hands-free off")
    }

    func testShutDownMidTakeLeavesNothingListening() async {
        let r = rig()
        r.voice.begin()
        await waitUntil("listening") { r.voice.phase == .listening }
        r.voice.shutDown()
        try? await Task.sleep(for: .milliseconds(600))
        XCTAssertNotEqual(r.voice.recorder.state, .recording)
        XCTAssertEqual(r.mics.count, 1)
        XCTAssertEqual(r.sent, [])
    }
}

/// The take so far as a WAV, and when its words are asked for.
@MainActor
final class VoiceLiveWordsTests: XCTestCase {
    private func cafURL(samples: [Int16]) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("live-\(UUID().uuidString).caf")
        let file = try AVAudioFile(forWriting: url, settings: VoiceRecorder.captureSettings,
                                   commonFormat: .pcmFormatInt16, interleaved: true)
        let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(samples.count))!
        buffer.frameLength = AVAudioFrameCount(samples.count)
        for (index, sample) in samples.enumerated() { buffer.int16ChannelData![0][index] = sample }
        try file.write(from: buffer)
        return url
    }

    private func pcm(ofWAV wav: Data) -> [Int16] {
        let bytes = [UInt8](wav)
        return stride(from: 44, to: bytes.count - 1, by: 2).map { Int16(bitPattern: UInt16(bytes[$0]) | UInt16(bytes[$0 + 1]) << 8) }
    }

    func testTheRecordersCAFBecomesAWAVWithTheSameSamples() throws {
        let samples: [Int16] = (0..<1_600).map { Int16(($0 * 37) % 2_000 - 1_000) }
        let url = try cafURL(samples: samples)
        defer { try? FileManager.default.removeItem(at: url) }
        let wav = try VoiceLiveWords.wav(ofTakeAt: url)
        XCTAssertEqual(String(bytes: wav.prefix(4), encoding: .ascii), "RIFF")
        XCTAssertEqual(String(bytes: wav[8..<12], encoding: .ascii), "WAVE")
        let rate = wav[24..<28].withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        XCTAssertEqual(UInt32(littleEndian: rate), 16_000)
        XCTAssertEqual(pcm(ofWAV: wav), samples)
    }

    func testAGrowingCAFWhoseDataHasNoSizeYetReadsToTheEnd() throws {
        let samples: [Int16] = (0..<800).map { Int16($0 - 400) }
        let url = try cafURL(samples: samples)
        defer { try? FileManager.default.removeItem(at: url) }
        var bytes = [UInt8](try Data(contentsOf: url))
        // Find the data chunk and mark its size unknown, as a take still recording does.
        let data = Array("data".utf8)
        let at = (8..<bytes.count - 4).first { Array(bytes[$0..<$0 + 4]) == data }!
        for index in at + 4..<at + 12 { bytes[index] = 0xFF }
        // A sample cut in half at the end is dropped, not read as noise.
        bytes.append(0x12)
        let wav = try XCTUnwrap(VoiceLiveWords.wav(fromCAF: Data(bytes)))
        XCTAssertEqual(pcm(ofWAV: wav), samples)
    }

    func testADataSizeOfZeroOrAStaleOneStillReadsTheWholeRecording() throws {
        let samples: [Int16] = (0..<800).map { Int16($0 - 400) }
        let url = try cafURL(samples: samples)
        defer { try? FileManager.default.removeItem(at: url) }
        let original = [UInt8](try Data(contentsOf: url))
        let data = Array("data".utf8)
        let at = (8..<original.count - 4).first { Array(original[$0..<$0 + 4]) == data }!
        for claimed: UInt64 in [0, 4 + 200] {
            var bytes = original
            for index in 0..<8 { bytes[at + 4 + index] = UInt8((claimed >> (8 * (7 - UInt64(index)))) & 0xFF) }
            let wav = try XCTUnwrap(VoiceLiveWords.wav(fromCAF: Data(bytes)), "size \(claimed)")
            XCTAssertEqual(pcm(ofWAV: wav), samples, "a data size of \(claimed) cut the recording")
        }
    }

    func testAnythingButTheRecordersPCMIsRefused() {
        XCTAssertNil(VoiceLiveWords.wav(fromCAF: Data("not a caf at all".utf8)))
        XCTAssertNil(VoiceLiveWords.wav(fromCAF: Data()))
    }

    func testDraftsComeOneAtATimeOnlyAfterSpeechAndADraftOfAnOldTakeIsDropped() async throws {
        let url = try cafURL(samples: Array(repeating: 100, count: 1_600))
        let other = try cafURL(samples: Array(repeating: 100, count: 1_600))
        defer { try? FileManager.default.removeItem(at: url); try? FileManager.default.removeItem(at: other) }
        let calls = Counter()
        let words = VoiceLiveWords(draft: { _ in
            await calls.bump()
            try await Task.sleep(for: .milliseconds(200))
            return "  turn on the  "
        })
        let start = Date()
        words.tick(takeURL: url, heardSpeech: true, elapsed: 0, now: start)
        words.tick(takeURL: url, heardSpeech: false, elapsed: 2, now: start.addingTimeInterval(2))
        try await Task.sleep(for: .milliseconds(100))
        let silent = await calls.value
        XCTAssertEqual(silent, 0, "a take that heard no speech was drafted")
        words.tick(takeURL: url, heardSpeech: true, elapsed: 4, now: start.addingTimeInterval(4))
        words.tick(takeURL: url, heardSpeech: true, elapsed: 6, now: start.addingTimeInterval(6))
        try await Task.sleep(for: .milliseconds(400))
        let drafted = await calls.value
        XCTAssertEqual(drafted, 1, "a second draft went out while one was in flight")
        XCTAssertEqual(words.text, "turn on the")
        // A new take: the old words leave the box, and a late draft of the old take is dropped.
        words.tick(takeURL: url, heardSpeech: true, elapsed: 8, now: start.addingTimeInterval(8))
        words.tick(takeURL: other, heardSpeech: true, elapsed: 0, now: start.addingTimeInterval(8.1))
        XCTAssertNil(words.text)
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertNil(words.text, "a draft of the previous take filled the new one's box")
    }

    func testAServerWithoutTheRouteIsNotAskedAgain() async throws {
        let url = try cafURL(samples: Array(repeating: 100, count: 1_600))
        defer { try? FileManager.default.removeItem(at: url) }
        let calls = Counter()
        let words = VoiceLiveWords(draft: { _ in
            await calls.bump()
            throw APIError.server(status: 404, code: "not_found", message: "Not found", serverHash: nil, serverContent: nil)
        })
        let start = Date()
        words.tick(takeURL: url, heardSpeech: true, elapsed: 0, now: start)
        words.tick(takeURL: url, heardSpeech: true, elapsed: 2, now: start.addingTimeInterval(2))
        try await Task.sleep(for: .milliseconds(200))
        words.tick(takeURL: url, heardSpeech: true, elapsed: 4, now: start.addingTimeInterval(4))
        try await Task.sleep(for: .milliseconds(200))
        let count = await calls.value
        XCTAssertEqual(count, 1)
        XCTAssertTrue(words.unsupported)
    }

    func testAfterTwoFailedDraftsTheTakeIsNotSentAgainAndFreezeKeepsTheWords() async throws {
        let url = try cafURL(samples: Array(repeating: 100, count: 1_600))
        defer { try? FileManager.default.removeItem(at: url) }
        let calls = Counter()
        let words = VoiceLiveWords(draft: { _ in
            await calls.bump()
            throw URLError(.notConnectedToInternet)
        })
        let start = Date()
        words.tick(takeURL: url, heardSpeech: true, elapsed: 0, now: start)
        for step in 1...5 {
            words.tick(takeURL: url, heardSpeech: true, elapsed: Double(step) * 2, now: start.addingTimeInterval(Double(step) * 2))
            try await Task.sleep(for: .milliseconds(150))
        }
        let failed = await calls.value
        XCTAssertEqual(failed, VoiceLiveWords.maxFailures, "a failing server kept being sent the take")

        let shown = VoiceLiveWords(draft: { _ in "turn on" })
        shown.tick(takeURL: url, heardSpeech: true, elapsed: 0, now: start)
        shown.tick(takeURL: url, heardSpeech: true, elapsed: 2, now: start.addingTimeInterval(2))
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(shown.text, "turn on")
        shown.freeze()
        XCTAssertEqual(shown.text, "turn on", "the words left the box while the take was being sent")
        shown.clear()
        XCTAssertNil(shown.text)
    }

    private actor Counter {
        private(set) var value = 0
        func bump() { value += 1 }
    }
}
