import XCTest
@testable import Walnut

/// Send waits for the words being spoken (`DictationSendGate`), on a real
/// `VoiceRecorder` with a temp store and a controllable transcription, so the
/// wait, the cancel, the failure and the order are the real state machine's.
@MainActor
final class DictationSendGateTests: XCTestCase {

    private var tempDir: URL!
    private var store: VoiceRecordingStore!

    override func setUp() async throws {
        try await super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("send-gate-tests-\(UUID().uuidString)", isDirectory: true)
        store = VoiceRecordingStore(baseDir: tempDir)
        VoiceRecordingStore._testResetDrainGate()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tempDir)
        VoiceRecordingStore._testResetDrainGate()
        try await super.tearDown()
    }

    // MARK: - Helpers

    private final class FakeCapture: AudioCapture {
        var currentTime: TimeInterval = 2
        private(set) var stopped = false
        func stop() { stopped = true }
    }

    /// A transcription that answers only when the test says so.
    @MainActor
    private final class Transcriber {
        private var waiting: CheckedContinuation<String, Error>?
        private(set) var calls = 0
        var isWaiting: Bool { waiting != nil }

        func upload() async throws -> String {
            calls += 1
            return try await withCheckedThrowingContinuation { waiting = $0 }
        }

        func answer(_ text: String) {
            waiting?.resume(returning: text)
            waiting = nil
        }

        func fail() {
            waiting?.resume(throwing: URLError(.notConnectedToInternet))
            waiting = nil
        }
    }

    /// A text box: the same join every dictation box uses.
    @MainActor
    private final class Box {
        var text = ""
        private(set) var inserts = 0
        func insert(_ words: String) {
            inserts += 1
            text = VoiceDictationText.appending(words, to: text) ?? text
        }
    }

    private struct Rig {
        let voice: VoiceRecorder
        let transcriber: Transcriber
        let box: Box
        let gate: DictationSendGate
    }

    private func rig(surface: String = "test:box") -> Rig {
        let voice = VoiceRecorder(store: store)
        voice.surface = surface
        let transcriber = Transcriber()
        voice.uploadOverride = { _ in try await transcriber.upload() }
        let box = Box()
        let gate = DictationSendGate()
        gate.register(voice) { box.insert($0) }
        return Rig(voice: voice, transcriber: transcriber, box: box, gate: gate)
    }

    @discardableResult
    private func beginTake(_ voice: VoiceRecorder) -> FakeCapture {
        let id = UUID().uuidString
        let url = store.newRecordingURL(id: id)
        try! Data(repeating: 0xAB, count: 4_000).write(to: url)
        let capture = FakeCapture()
        voice._testBeginTake(capture: capture, url: url, id: id)
        return capture
    }

    private func waitUntil(_ what: String, _ condition: () -> Bool) async {
        for _ in 0..<2_000 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("timed out waiting for \(what)")
    }

    // MARK: - Nothing to wait for

    func testSendWithNothingDictatedSendsAtOnce() {
        let r = rig()
        r.box.text = "Hello"
        var sent: [String] = []
        var waitedFlags: [Bool] = []
        let task = r.gate.send { waited in
            waitedFlags.append(waited)
            sent.append(r.box.text)
        }
        XCTAssertNil(task, "an idle box sends in the tap's own turn")
        XCTAssertEqual(sent, ["Hello"])
        XCTAssertEqual(waitedFlags, [false])
        XCTAssertFalse(r.gate.isWaiting)
        XCTAssertEqual(r.gate.lastOutcome, .sentNow)
    }

    // MARK: - Send while recording

    func testSendWhileRecordingStopsWaitsInsertsAndSendsOnceInOrder() async throws {
        let r = rig()
        r.box.text = "Typed first"
        let capture = beginTake(r.voice)
        XCTAssertTrue(r.gate.isDictating, "a running take makes Send wait")
        var sent: [String] = []
        let task = try XCTUnwrap(r.gate.send { waited in
            XCTAssertTrue(waited)
            sent.append(r.box.text)
        })
        XCTAssertTrue(r.gate.isWaiting, "the button shows it is waiting")
        XCTAssertEqual(sent, [], "nothing leaves before the words")

        await waitUntil("the take to stop and upload") { r.transcriber.isWaiting }
        XCTAssertTrue(capture.stopped, "Send stopped the take")
        XCTAssertEqual(r.voice.state, .transcribing)
        XCTAssertEqual(sent, [], "still nothing while the words are on their way")

        r.transcriber.answer("and then the spoken words")
        let outcome = await task.value
        XCTAssertEqual(outcome, .sentAfterWords)
        XCTAssertEqual(sent, ["Typed first and then the spoken words"], "typed text then the words, sent once")
        XCTAssertEqual(r.box.inserts, 1, "the words went into the box exactly once")
        XCTAssertFalse(r.gate.isWaiting)
        XCTAssertEqual(r.voice.state, .idle)
        XCTAssertEqual(r.transcriber.calls, 1, "one upload for one take")
    }

    func testEmptyBoxThenSpokenWordsAreSent() async throws {
        let r = rig()
        beginTake(r.voice)
        var sent: [String] = []
        let task = try XCTUnwrap(r.gate.send { _ in sent.append(r.box.text) })
        await waitUntil("upload") { r.transcriber.isWaiting }
        r.transcriber.answer("Remind me to call the contractor")
        _ = await task.value
        XCTAssertEqual(sent, ["Remind me to call the contractor"])
    }

    // MARK: - Send while a transcription is already on its way

    func testSendAfterStopWaitsForTheStopsWordsWithoutInsertingTwice() async throws {
        let r = rig()
        r.box.text = "Typed"
        beginTake(r.voice)
        // The person tapped Stop (the box's own path inserts the words)...
        let stop = Task { @MainActor in
            if let words = await r.voice.stopAndTranscribe() { r.box.insert(words) }
        }
        await waitUntil("the stop's upload") { r.transcriber.isWaiting }
        XCTAssertEqual(r.voice.state, .transcribing)
        // ...then Send while the words are still coming.
        var sent: [String] = []
        let task = try XCTUnwrap(r.gate.send { _ in sent.append(r.box.text) })
        XCTAssertTrue(r.gate.isWaiting)
        r.transcriber.answer("spoken")
        let outcome = await task.value
        await stop.value
        XCTAssertEqual(outcome, .sentAfterWords)
        XCTAssertEqual(sent, ["Typed spoken"])
        XCTAssertEqual(r.box.inserts, 1, "only the Stop path inserted the words")
    }

    // MARK: - Cancel

    func testSecondTapCancelsAndTheWordsStillLandUnsent() async throws {
        let r = rig()
        r.box.text = "Draft"
        beginTake(r.voice)
        var sent: [String] = []
        let task = try XCTUnwrap(r.gate.send { _ in sent.append(r.box.text) })
        await waitUntil("upload") { r.transcriber.isWaiting }
        XCTAssertNil(r.gate.send { _ in sent.append("second tap must not send") }, "the second tap only cancels")
        XCTAssertFalse(r.gate.isWaiting, "the button is back to Send at once")
        r.transcriber.answer("kept words")
        let outcome = await task.value
        XCTAssertEqual(outcome, .cancelled)
        XCTAssertEqual(sent, [], "a cancelled wait sends nothing")
        XCTAssertEqual(r.box.text, "Draft kept words", "the words still land in the box")
    }

    func testCancelWaitFromOutsideKeepsWordsUnsent() async throws {
        let r = rig()
        beginTake(r.voice)
        var sent = 0
        let task = try XCTUnwrap(r.gate.send { _ in sent += 1 })
        r.gate.cancelWait()
        await waitUntil("upload") { r.transcriber.isWaiting }
        r.transcriber.answer("closed sheet words")
        _ = await task.value
        XCTAssertEqual(sent, 0)
        XCTAssertEqual(r.box.text, "closed sheet words")
    }

    // MARK: - Failure

    func testFailedTranscriptionSendsNothingKeepsTextAndShowsTheError() async throws {
        let r = rig()
        r.box.text = "What I typed"
        beginTake(r.voice)
        var sent = 0
        let task = try XCTUnwrap(r.gate.send { _ in sent += 1 })
        await waitUntil("upload") { r.transcriber.isWaiting }
        r.transcriber.fail()
        let outcome = await task.value
        XCTAssertEqual(outcome, .failed)
        XCTAssertEqual(sent, 0, "a failed transcription sends nothing")
        XCTAssertEqual(r.box.text, "What I typed", "the typed text stays")
        XCTAssertFalse(r.gate.isWaiting)
        XCTAssertNotNil(r.voice.errorMessage, "the notice row has the error")
        XCTAssertEqual(r.voice.pendingCount, 1, "the take is kept for Retry")
    }

    func testEmptyTranscriptSendsNothing() async throws {
        let r = rig()
        r.box.text = "Typed"
        beginTake(r.voice)
        var sent = 0
        let task = try XCTUnwrap(r.gate.send { _ in sent += 1 })
        await waitUntil("upload") { r.transcriber.isWaiting }
        r.transcriber.answer("   ")
        let outcome = await task.value
        XCTAssertEqual(outcome, .failed)
        XCTAssertEqual(sent, 0)
        XCTAssertEqual(r.box.text, "Typed")
    }

    // MARK: - Again

    func testSendWorksAgainAfterAWait() async throws {
        let r = rig()
        beginTake(r.voice)
        var sent: [String] = []
        let send: (Bool) -> Void = { _ in
            sent.append(r.box.text)
            r.box.text = ""
        }
        let first = try XCTUnwrap(r.gate.send(send))
        await waitUntil("upload") { r.transcriber.isWaiting }
        r.transcriber.answer("first message")
        _ = await first.value

        r.box.text = "second, typed"
        XCTAssertNil(r.gate.send(send), "nothing dictated: sends at once")
        XCTAssertEqual(sent, ["first message", "second, typed"])

        // And a second spoken one waits again.
        beginTake(r.voice)
        let third = try XCTUnwrap(r.gate.send(send))
        await waitUntil("upload") { r.transcriber.isWaiting }
        r.transcriber.answer("third, spoken")
        _ = await third.value
        XCTAssertEqual(sent, ["first message", "second, typed", "third, spoken"])
    }

    // MARK: - Words nobody saw

    func testWordsAnAutomaticDrainRecoveredAreHeldForReview() async throws {
        let r = rig(surface: "test:box")
        // A take kept by an earlier run, spoken into this box.
        let id = UUID().uuidString
        try Data(repeating: 1, count: 2_000).write(to: store.newRecordingURL(id: id))
        store.preserve(id: id, reason: "interrupted", surface: "test:box")
        let drain = Task { @MainActor in
            if let words = await r.voice.retryPending(userInitiated: false) { r.box.insert(words) }
        }
        await waitUntil("the drain's upload") { r.transcriber.isWaiting }
        var sent = 0
        let task = try XCTUnwrap(r.gate.send { _ in sent += 1 })
        r.transcriber.answer("words from an hour ago")
        let outcome = await task.value
        await drain.value
        XCTAssertEqual(outcome, .heldForReview)
        XCTAssertEqual(sent, 0, "words the person never saw are not sent unread")
        XCTAssertEqual(r.box.text, "words from an hour ago")
    }

    func testWordsAManualRetryRecoveredAreHeldForReview() async throws {
        let r = rig(surface: "test:box")
        let id = UUID().uuidString
        try Data(repeating: 1, count: 2_000).write(to: store.newRecordingURL(id: id))
        store.preserve(id: id, reason: "transcribe-failed", surface: "other:box")
        let retry = Task { @MainActor in
            if let words = await r.voice.retryPending() { r.box.insert(words) }
        }
        await waitUntil("the retry's upload") { r.transcriber.isWaiting }
        var sent = 0
        let task = try XCTUnwrap(r.gate.send { _ in sent += 1 })
        r.transcriber.answer("words from another box")
        let outcome = await task.value
        await retry.value
        XCTAssertEqual(outcome, .heldForReview, "a retried take's words are read before they are sent")
        XCTAssertEqual(sent, 0)
        XCTAssertEqual(r.box.text, "words from another box")
    }

    /// A call cuts the take off right after Send: the take is kept and recovered
    /// into the box, and nothing is sent without the person reading it.
    func testATakeACallCutOffIsNotSent() async throws {
        let r = rig()
        r.voice.onAutoStopText = { r.box.insert($0) }
        r.box.text = "Typed"
        beginTake(r.voice)
        var sent = 0
        let task = try XCTUnwrap(r.gate.send { _ in sent += 1 })
        r.voice._testSimulateInterruption()
        await waitUntil("the recovery's upload") { r.transcriber.isWaiting }
        r.transcriber.answer("recovered words")
        let outcome = await task.value
        await waitUntil("the recovered words in the box") { r.box.text.contains("recovered words") }
        XCTAssertTrue(outcome == .failed || outcome == .heldForReview, "outcome \(outcome)")
        XCTAssertEqual(sent, 0, "words nobody read are not sent")
        XCTAssertEqual(r.box.text, "Typed recovered words")
        XCTAssertFalse(r.gate.isWaiting)
    }

    /// Cancel, then Send again while the same words are still coming: the second
    /// wait sends them, once.
    func testSendAgainAfterACancelWaitsForTheSameWords() async throws {
        let r = rig()
        beginTake(r.voice)
        var sent: [String] = []
        let first = try XCTUnwrap(r.gate.send { _ in sent.append("first: " + r.box.text) })
        await waitUntil("upload") { r.transcriber.isWaiting }
        XCTAssertNil(r.gate.send { _ in sent.append("cancel tap") })
        let second = try XCTUnwrap(r.gate.send { _ in sent.append("second: " + r.box.text) })
        XCTAssertTrue(r.gate.isWaiting)
        r.transcriber.answer("the words")
        let outcomes = (await first.value, await second.value)
        XCTAssertEqual(outcomes.0, .cancelled)
        XCTAssertEqual(outcomes.1, .sentAfterWords)
        XCTAssertEqual(sent, ["second: the words"])
        XCTAssertEqual(r.box.inserts, 1)
    }

    /// Two boxes on one screen, both busy: Send stops both at once and sends once
    /// both words are in.
    func testTwoBusyBoxesAreBothWaitedFor() async throws {
        let r = rig(surface: "test:one")
        let other = VoiceRecorder(store: store)
        other.surface = "test:two"
        let otherTranscriber = Transcriber()
        other.uploadOverride = { _ in try await otherTranscriber.upload() }
        let otherBox = Box()
        r.gate.register(other) { otherBox.insert($0) }
        beginTake(r.voice)
        let otherCapture = beginTake(other)
        var sent: [String] = []
        let task = try XCTUnwrap(r.gate.send { _ in sent.append(r.box.text + " | " + otherBox.text) })
        await waitUntil("both uploads") { r.transcriber.isWaiting && otherTranscriber.isWaiting }
        XCTAssertTrue(otherCapture.stopped, "the second box stopped at once, not after the first's words")
        otherTranscriber.answer("second answer")
        r.transcriber.answer("first answer")
        _ = await task.value
        XCTAssertEqual(sent, ["first answer | second answer"])
    }

    /// A stale leave (the old view's disappear after the new one's appear) does
    /// not remove the box that replaced it.
    func testAStaleUnregisterKeepsTheNewEntry() {
        let r = rig()
        let stale = r.gate.register(r.voice) { _ in }
        let current = r.gate.register(r.voice) { r.box.insert($0) }
        r.gate.unregister(r.voice, token: stale)
        beginTake(r.voice)
        XCTAssertTrue(r.gate.isDictating, "the current entry is still there")
        r.gate.unregister(r.voice, token: current)
        XCTAssertFalse(r.gate.isDictating)
        r.voice.cancel()
    }

    func testABoxThatLeftTheGateIsNotWaitedFor() {
        let r = rig()
        beginTake(r.voice)
        r.gate.unregister(r.voice)
        var sent = 0
        XCTAssertNil(r.gate.send { _ in sent += 1 })
        XCTAssertEqual(sent, 1)
        r.voice.cancel()
    }
}
