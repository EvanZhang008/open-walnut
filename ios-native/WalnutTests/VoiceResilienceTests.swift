import XCTest
@testable import Walnut

/// Voice recording resilience — the no-loss state machine.
///
/// Field incident 2026-08-09: a long dictation vanished when the phone
/// auto-locked mid-take. Root causes: (1) LifecycleHub.suspendAll() called
/// VoiceRecorder.cancel() on background, which DELETED the live take; (2) a
/// 90s hard cap auto-stopped long dictations; (3) stopAndTranscribe deleted
/// the audio file on EVERY outcome, success or failure.
///
/// The contract under test: audio is deleted only after transcription
/// succeeded (or explicit user discard); every failure path preserves the
/// file for retry. The recorder is protocol-seamed (`AudioCapture`,
/// `uploadOverride`, injected store dir) so none of this needs a microphone
/// or a server.
final class VoiceResilienceTests: XCTestCase {

    private var tempDir: URL!
    private var store: VoiceRecordingStore!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-tests-\(UUID().uuidString)", isDirectory: true)
        store = VoiceRecordingStore(baseDir: tempDir)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        super.tearDown()
    }

    // MARK: - Helpers

    private final class FakeCapture: AudioCapture {
        var currentTime: TimeInterval = 0
        private(set) var stopped = false
        func stop() { stopped = true }
    }

    /// Write a fake m4a into the store and put the recorder into `.recording`.
    @MainActor
    private func beginTake(_ recorder: VoiceRecorder, bytes: Int = 4_000) -> (id: String, url: URL, capture: FakeCapture) {
        let id = UUID().uuidString
        let url = store.newRecordingURL(id: id)
        try! Data(repeating: 0xAB, count: bytes).write(to: url)
        let capture = FakeCapture()
        recorder._testBeginTake(capture: capture, url: url, id: id)
        return (id, url, capture)
    }

    private func audioExists(_ id: String) -> Bool {
        FileManager.default.fileExists(atPath: tempDir.appendingPathComponent("\(id).m4a").path)
    }

    // MARK: - Store basics

    func testStorePreservePendingAndDiscard() {
        let url = store.newRecordingURL(id: "take1")
        try! Data(repeating: 1, count: 2_000).write(to: url)
        store.preserve(id: "take1", reason: "recording")

        let pending = store.pending()
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending[0].id, "take1")
        XCTAssertEqual(pending[0].reason, "recording")
        XCTAssertEqual(pending[0].bytes, 2_000)

        // Re-marking with a new reason must keep the original createdAt.
        let created = pending[0].createdAt
        store.preserve(id: "take1", reason: "transcribe-failed")
        let after = store.pending()
        XCTAssertEqual(after[0].reason, "transcribe-failed")
        XCTAssertEqual(after[0].createdAt.timeIntervalSince1970,
                       created.timeIntervalSince1970, accuracy: 0.01)

        store.discard(id: "take1")
        XCTAssertTrue(store.pending().isEmpty)
        XCTAssertFalse(audioExists("take1"))
    }

    func testStorePendingIsOldestFirst() {
        for (i, id) in ["a", "b", "c"].enumerated() {
            let url = store.newRecordingURL(id: id)
            try! Data(repeating: 1, count: 1_500).write(to: url)
            store.preserve(id: id, reason: "recording",
                           createdAt: Date(timeIntervalSince1970: Double(100 - i)))
        }
        // c is oldest (t=98), then b, then a.
        XCTAssertEqual(store.pending().map(\.id), ["c", "b", "a"])
    }

    func testStorePruneAgeAndCount() {
        // One ancient take → pruned by age.
        let old = store.newRecordingURL(id: "ancient")
        try! Data(repeating: 1, count: 1_500).write(to: old)
        store.preserve(id: "ancient", reason: "recording",
                       createdAt: Date().addingTimeInterval(-VoiceRecordingStore.maxAge - 60))

        // maxCount+2 fresh takes → 2 oldest pruned by count.
        let n = VoiceRecordingStore.maxCount + 2
        for i in 0..<n {
            let url = store.newRecordingURL(id: "fresh-\(i)")
            try! Data(repeating: 1, count: 1_500).write(to: url)
            store.preserve(id: "fresh-\(i)", reason: "recording",
                           createdAt: Date().addingTimeInterval(Double(i - n)))
        }

        let removed = store.prune()
        XCTAssertEqual(removed, 3, "1 by age + 2 over maxCount")
        XCTAssertEqual(store.pending().count, VoiceRecordingStore.maxCount)
        XCTAssertFalse(audioExists("ancient"))
        XCTAssertFalse(audioExists("fresh-0"))
        XCTAssertFalse(audioExists("fresh-1"))
    }

    func testStoreListsAudioWithoutSidecar() {
        // Pre-fix straggler: audio but no sidecar must still be recoverable.
        let url = store.newRecordingURL(id: "bare")
        try! Data(repeating: 1, count: 1_500).write(to: url)
        let pending = store.pending()
        XCTAssertEqual(pending.map(\.id), ["bare"])
        XCTAssertEqual(pending[0].reason, "unknown")
    }

    // MARK: - Recorder: failure preserves, success deletes

    @MainActor
    func testUploadFailurePreservesAudioAndSurfacesRetry() async {
        let recorder = VoiceRecorder(store: store)
        recorder.uploadOverride = { _ in
            throw APIError.server(status: 503, code: "stt_unavailable",
                                  message: "engine down", serverHash: nil, serverContent: nil)
        }
        let take = beginTake(recorder)

        let text = await recorder.stopAndTranscribe()

        XCTAssertNil(text)
        XCTAssertTrue(take.capture.stopped)
        XCTAssertTrue(audioExists(take.id), "failed upload must NOT delete the audio")
        XCTAssertEqual(store.pending().first?.reason, "transcribe-failed")
        XCTAssertEqual(recorder.pendingCount, 1, "retry affordance must surface")
        XCTAssertNotNil(recorder.errorMessage)
        XCTAssertTrue(recorder.errorMessage!.contains("saved"),
                      "user must learn the recording is kept: \(recorder.errorMessage!)")
    }

    @MainActor
    func testUploadSuccessDeletesAudio() async {
        let recorder = VoiceRecorder(store: store)
        recorder.uploadOverride = { _ in "hello world" }
        let take = beginTake(recorder)

        let text = await recorder.stopAndTranscribe()

        XCTAssertEqual(text, "hello world")
        XCTAssertFalse(audioExists(take.id), "success is the one path that deletes")
        XCTAssertEqual(recorder.pendingCount, 0)
        XCTAssertEqual(recorder.state, .idle)
    }

    @MainActor
    func testCancelledUploadPreservesWithoutErrorUI() async {
        let recorder = VoiceRecorder(store: store)
        recorder.uploadOverride = { _ in throw CancellationError() }
        let take = beginTake(recorder)

        let text = await recorder.stopAndTranscribe()

        XCTAssertNil(text)
        XCTAssertTrue(audioExists(take.id), "lifecycle cancel must preserve the audio")
        XCTAssertEqual(store.pending().first?.reason, "background")
        XCTAssertNil(recorder.errorMessage, "lifecycle isn't a user-visible error")
        XCTAssertEqual(recorder.pendingCount, 1)
    }

    @MainActor
    func testEmptyTranscriptionPreservesAudio() async {
        let recorder = VoiceRecorder(store: store)
        recorder.uploadOverride = { _ in "   " }
        let take = beginTake(recorder)

        let text = await recorder.stopAndTranscribe()

        XCTAssertNil(text)
        XCTAssertTrue(audioExists(take.id), "a misheard take must not be destroyed")
        XCTAssertEqual(recorder.pendingCount, 1)
    }

    @MainActor
    func testTooShortTakeIsDiscardedNotPreserved() async {
        let recorder = VoiceRecorder(store: store)
        recorder.uploadOverride = { _ in XCTFail("sub-1KB take must not upload"); return "" }
        let take = beginTake(recorder, bytes: 500)

        let text = await recorder.stopAndTranscribe()

        XCTAssertNil(text)
        XCTAssertFalse(audioExists(take.id), "accidental tap leaves nothing behind")
        XCTAssertEqual(recorder.pendingCount, 0)
    }

    @MainActor
    func testExplicitCancelDeletes() {
        let recorder = VoiceRecorder(store: store)
        let take = beginTake(recorder)

        recorder.cancel()

        XCTAssertFalse(audioExists(take.id), "user's explicit ✕ is a real delete")
        XCTAssertEqual(recorder.state, .idle)
        XCTAssertTrue(take.capture.stopped)
    }

    @MainActor
    func testPreserveAndStopKeepsAudio() {
        let recorder = VoiceRecorder(store: store)
        let take = beginTake(recorder)

        recorder.preserveAndStop(reason: "view-dismissed")

        XCTAssertTrue(audioExists(take.id), "navigation away must never delete a take")
        XCTAssertEqual(store.pending().first?.reason, "view-dismissed")
        XCTAssertEqual(recorder.state, .idle)
        XCTAssertEqual(recorder.pendingCount, 1)
    }

    // MARK: - Retry surface

    @MainActor
    func testRetryPendingTranscribesOldestFirstAndJoins() async {
        let recorder = VoiceRecorder(store: store)
        for (i, id) in ["first", "second"].enumerated() {
            let url = store.newRecordingURL(id: id)
            try! Data(repeating: 2, count: 2_000).write(to: url)
            store.preserve(id: id, reason: "transcribe-failed",
                           createdAt: Date(timeIntervalSince1970: Double(1_000 + i)))
        }
        var uploads = 0
        recorder.uploadOverride = { _ in
            uploads += 1
            return uploads == 1 ? "part one" : "part two"
        }

        let text = await recorder.retryPending()

        XCTAssertEqual(text, "part one part two", "oldest first, joined in spoken order")
        XCTAssertEqual(recorder.pendingCount, 0)
        XCTAssertFalse(audioExists("first"))
        XCTAssertFalse(audioExists("second"))
    }

    @MainActor
    func testRetryPendingStopsAtFirstFailureKeepingRemainder() async {
        let recorder = VoiceRecorder(store: store)
        for (i, id) in ["ok", "bad", "later"].enumerated() {
            let url = store.newRecordingURL(id: id)
            try! Data(repeating: 2, count: 2_000).write(to: url)
            store.preserve(id: id, reason: "transcribe-failed",
                           createdAt: Date(timeIntervalSince1970: Double(1_000 + i)))
        }
        var uploads = 0
        recorder.uploadOverride = { _ in
            uploads += 1
            if uploads == 1 { return "recovered" }
            throw APIError.server(status: 503, code: "stt_unavailable",
                                  message: "down again", serverHash: nil, serverContent: nil)
        }

        let text = await recorder.retryPending()

        XCTAssertEqual(text, "recovered", "successes before the failure still land")
        XCTAssertEqual(uploads, 2, "loop stops at the first hard failure")
        XCTAssertFalse(audioExists("ok"))
        XCTAssertTrue(audioExists("bad"), "failed take stays recoverable")
        XCTAssertTrue(audioExists("later"), "untried take stays recoverable")
        XCTAssertEqual(recorder.pendingCount, 2)
    }

    @MainActor
    func testDiscardPendingRemovesAll() {
        let recorder = VoiceRecorder(store: store)
        for id in ["x", "y"] {
            let url = store.newRecordingURL(id: id)
            try! Data(repeating: 2, count: 2_000).write(to: url)
            store.preserve(id: id, reason: "transcribe-failed")
        }
        recorder.refreshPending()
        XCTAssertEqual(recorder.pendingCount, 2)

        recorder.discardPending()

        XCTAssertEqual(recorder.pendingCount, 0)
        XCTAssertTrue(store.pending().isEmpty)
    }

    // MARK: - Interruption

    @MainActor
    func testInterruptionPreservesThenAutoTranscribes() async {
        let recorder = VoiceRecorder(store: store)
        recorder.uploadOverride = { _ in "partial words" }
        let take = beginTake(recorder)

        let landed = expectation(description: "auto-stop text lands in the handler")
        var received: String?
        recorder.onAutoStopText = { text in
            received = text
            landed.fulfill()
        }

        recorder._testSimulateInterruption()
        XCTAssertEqual(recorder.state, .idle, "interruption stops the take immediately")
        XCTAssertTrue(take.capture.stopped)

        await fulfillment(of: [landed], timeout: 5)
        XCTAssertEqual(received, "partial words")
        XCTAssertFalse(audioExists(take.id), "auto-retry succeeded → audio deleted")
    }

    @MainActor
    func testInterruptionWithDeadServerKeepsAudioForLater() async {
        let recorder = VoiceRecorder(store: store)
        let attempted = expectation(description: "auto-retry attempted the upload")
        recorder.uploadOverride = { _ in
            attempted.fulfill()
            throw APIError.server(status: 503, code: "stt_unavailable",
                                  message: "offline", serverHash: nil, serverContent: nil)
        }
        let take = beginTake(recorder)

        recorder._testSimulateInterruption()
        XCTAssertTrue(audioExists(take.id), "interruption itself must preserve immediately")

        // The fire-and-forget auto-retry fails against the dead server…
        await fulfillment(of: [attempted], timeout: 5)
        // …then drain the MainActor so its preserve/refresh epilogue runs.
        for _ in 0..<20 where recorder.state != .idle {
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertTrue(audioExists(take.id), "interrupted take survives a dead server")
        XCTAssertEqual(recorder.pendingCount, 1)
    }
}
