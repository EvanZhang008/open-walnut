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
        // The drain gate is process-wide ON PURPOSE (see `claimDrain`), so it is
        // the one piece of state a fresh store does not reset. Left alone, one
        // test's automatic drain arms the cooldown and the NEXT test's drain is
        // silently refused — a false green that looks like "nothing to drain".
        VoiceRecordingStore._testResetDrainGate()
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        VoiceRecordingStore._testResetDrainGate()
        super.tearDown()
    }

    // MARK: - Helpers

    private final class FakeCapture: AudioCapture {
        var currentTime: TimeInterval = 0
        private(set) var stopped = false
        func stop() { stopped = true }
    }

    /// A recorder that owns the surface it records for — what a real mounted
    /// `ComposerBar` is (it stamps `voice.surface` in `onAppear`). Tests that
    /// exercise the AUTOMATIC drain must use this, because an unidentified
    /// recorder owns nothing and correctly drains nothing.
    @MainActor
    private func ownedRecorder(surface: String = "tab:chat", ownsOrphans: Bool = true) -> VoiceRecorder {
        let rec = VoiceRecorder(store: store)
        rec.surface = surface
        rec.ownsOrphanTakes = ownsOrphans
        return rec
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

    /// THE HEAD-OF-LINE BUG (D2, field report 2026-08-30). The drain used to
    /// `break` at the first failure, so one take the server could not read held
    /// every recording behind it for the full 7-day retention: the banner
    /// counted 3, and every Retry tap reproduced the same head failure and
    /// reached none of the good audio. The poisoned take must not block the
    /// takes behind it.
    @MainActor
    func testRetryPendingContinuesPastAPoisonedHeadAndDrainsTheRest() async {
        let recorder = VoiceRecorder(store: store)
        for (i, id) in ["poison", "good", "alsoGood"].enumerated() {
            let url = store.newRecordingURL(id: id)
            try! Data(repeating: 2, count: 2_000).write(to: url)
            store.preserve(id: id, reason: "transcribe-failed",
                           createdAt: Date(timeIntervalSince1970: Double(1_000 + i)))
        }
        var uploads = 0
        recorder.uploadOverride = { _ in
            uploads += 1
            // The OLDEST take (drained first) is the one that fails.
            if uploads == 1 {
                throw APIError.server(status: 503, code: "stt_unavailable",
                                      message: "down again", serverHash: nil, serverContent: nil)
            }
            return uploads == 2 ? "second words" : "third words"
        }

        let text = await recorder.retryPending()

        XCTAssertEqual(uploads, 3, "every take gets its own attempt — a failure is not a verdict on the others")
        XCTAssertEqual(text, "second words third words",
                       "the takes behind the failure are recovered, in spoken order")
        XCTAssertTrue(audioExists("poison"), "the failed take stays recoverable")
        XCTAssertFalse(audioExists("good"))
        XCTAssertFalse(audioExists("alsoGood"))
        XCTAssertEqual(recorder.pendingCount, 1, "only the failed take is left pending")
        XCTAssertEqual(recorder.failedCount, 0, "a 503 is not the audio's fault — it keeps its retries")
    }

    // MARK: - Terminal retirement (the permanent banner)

    /// The exact loop the user reported: the server answers 200 with no text, so
    /// the take is preserved and marked failed, and retrying the same bytes gets
    /// the same empty answer forever. After one honest retry it must leave
    /// "pending" and say what actually happened.
    @MainActor
    func testEmptyTranscriptionIsTerminalAfterOneRetry() async {
        let recorder = VoiceRecorder(store: store)
        recorder.uploadOverride = { _ in "" }
        let take = beginTake(recorder)

        // Attempt 1 — the live take. Still pending: the engine can change
        // between attempts (Mac reconnects, different model), so one retry is
        // honest.
        _ = await recorder.stopAndTranscribe()
        XCTAssertEqual(recorder.pendingCount, 1, "first empty answer earns a retry")
        XCTAssertEqual(recorder.failedCount, 0)
        XCTAssertEqual(store.pending().first?.attempts, 1)
        XCTAssertEqual(store.pending().first?.verdicts, 1)

        // Attempt 2 — the retry. Same answer, so this is the last word.
        _ = await recorder.retryPending()

        XCTAssertEqual(recorder.pendingCount, 0, "it must stop claiming a transcription is pending")
        XCTAssertEqual(recorder.failedCount, 1, "it moves to the couldn't-transcribe row")
        XCTAssertTrue(audioExists(take.id), "retiring a take must NEVER delete the user's audio")
        XCTAssertEqual(recorder.errorMessage, "Couldn't transcribe that recording — Discard it or keep it for later")
        XCTAssertTrue(store.pending().first?.isTerminal == true)
    }

    /// A retired take is skipped, not re-uploaded. Re-uploading is what made the
    /// banner permanent, and it also means a poisoned take burns bandwidth and
    /// time on every drain forever.
    @MainActor
    func testRetiredTakeIsSkippedAndReportsHonestly() async {
        let recorder = VoiceRecorder(store: store)
        let url = store.newRecordingURL(id: "retired")
        try! Data(repeating: 3, count: 2_000).write(to: url)
        // Two empty verdicts already on the sidecar = out of retries.
        store.noteAttempt(id: "retired", reason: "transcribe-failed", kind: .empty, message: "no speech")
        store.noteAttempt(id: "retired", reason: "transcribe-failed", kind: .empty, message: "no speech")
        recorder.refreshPending()
        XCTAssertEqual(recorder.pendingCount, 0)
        XCTAssertEqual(recorder.failedCount, 1)

        recorder.uploadOverride = { _ in
            XCTFail("a retired take must not be uploaded again")
            return ""
        }
        let text = await recorder.retryPending()

        XCTAssertNil(text)
        XCTAssertTrue(audioExists("retired"), "still the user's audio until they discard it")
        XCTAssertEqual(recorder.errorMessage,
                       "That recording couldn't be transcribed — Discard to clear it",
                       "a Retry tap must never be a silent no-op")

        recorder.discardFailed()
        XCTAssertFalse(audioExists("retired"), "Discard is the exit the old row never offered")
        XCTAssertEqual(recorder.failedCount, 0)
    }

    /// The counter-case, and the reason retirement counts VERDICTS: a sleeping
    /// Mac must not be able to prove a good dictation untranscribable in two
    /// taps. Right up to the attempt ceiling the take stays plainly pending.
    @MainActor
    func testTransportFailuresDoNotRetireARecordingBeforeTheCeiling() async {
        let recorder = VoiceRecorder(store: store)
        let url = store.newRecordingURL(id: "offline")
        try! Data(repeating: 4, count: 2_000).write(to: url)
        store.preserve(id: "offline", reason: "transcribe-failed")
        recorder.uploadOverride = { _ in
            throw APIError.server(status: 503, code: "stt_unavailable",
                                  message: "bridge offline", serverHash: nil, serverContent: nil)
        }

        for _ in 0..<(VoiceRetryPlan.attemptCeiling - 1) { _ = await recorder.retryPending() }

        let rec = store.pending().first
        XCTAssertEqual(rec?.attempts, VoiceRetryPlan.attemptCeiling - 1, "every attempt is counted")
        XCTAssertEqual(rec?.verdicts, 0, "none of them said anything about the audio")
        XCTAssertFalse(rec?.isTerminal ?? true)
        XCTAssertEqual(recorder.pendingCount, 1, "still pending, still retryable")
        XCTAssertEqual(recorder.failedCount, 0)
    }

    /// The failure shape the fix originally MISSED, reproduced from the live app:
    /// kill the process mid-recording and the m4a is never finalized (no `moov`
    /// atom), so the server's ffmpeg rejects it and the route reports that as
    /// `503 stt_unavailable` — transport-shaped by every signal the phone has.
    /// Verdicts stay 0 forever, so a verdict-only rule leaves THE ORIGINAL
    /// PERMANENT BANNER in place for a file that is simply broken.
    ///
    /// At the ceiling it must leave "pending" — while keeping a manual retry,
    /// because nothing ever judged the audio itself.
    @MainActor
    func testAnEndlesslyFailingTakeIsRetiredAtTheCeilingButStaysRetryable() async {
        let recorder = ownedRecorder()
        let url = store.newRecordingURL(id: "broken")
        try! Data(repeating: 4, count: 2_000).write(to: url)
        store.preserve(id: "broken", reason: "transcribe-failed")
        var uploads = 0
        recorder.uploadOverride = { _ in
            uploads += 1
            throw APIError.server(
                status: 503, code: "stt_unavailable",
                message: "ffmpeg: moov atom not found", serverHash: nil, serverContent: nil)
        }

        for _ in 0..<VoiceRetryPlan.attemptCeiling { _ = await recorder.retryPending() }

        XCTAssertEqual(uploads, VoiceRetryPlan.attemptCeiling)
        XCTAssertEqual(recorder.pendingCount, 0, "it must stop claiming a transcription is pending")
        XCTAssertEqual(recorder.failedCount, 1)
        XCTAssertEqual(recorder.recoverableFailedCount, 1,
                       "nothing judged the audio, so the row keeps a secondary Retry")
        XCTAssertTrue(audioExists("broken"))

        // The automatic drain leaves it alone…
        recorder.uploadOverride = { _ in
            XCTFail("the auto-drain must not keep re-uploading a retired take")
            return ""
        }
        recorder.drainPending(trigger: "test")
        try? await Task.sleep(for: .milliseconds(100))

        // …but the user's own "Try again" is still honoured, and can still win.
        recorder.uploadOverride = { _ in "it worked on a better day" }
        let text = await recorder.retryPending(includeRetired: true)
        XCTAssertEqual(text, "it worked on a better day",
                       "a ceiling-retired take must stay recoverable by hand")
        XCTAssertFalse(audioExists("broken"))
        XCTAssertEqual(recorder.failedCount, 0)
    }

    /// A VERDICT-retired take is different: the engine has answered on this exact
    /// audio twice, so even an explicit "Try again" must not re-upload it. The row
    /// offers no such button, and the flag the row reads says so.
    @MainActor
    func testVerdictRetiredTakeIsNotOfferedARetryAtAll() async {
        let recorder = VoiceRecorder(store: store)
        let url = store.newRecordingURL(id: "judged")
        try! Data(repeating: 4, count: 2_000).write(to: url)
        store.noteAttempt(id: "judged", reason: "transcribe-failed", kind: .empty, message: "no speech")
        store.noteAttempt(id: "judged", reason: "transcribe-failed", kind: .empty, message: "no speech")
        recorder.refreshPending()

        XCTAssertEqual(recorder.failedCount, 1)
        XCTAssertEqual(recorder.recoverableFailedCount, 0, "no Retry is offered for a judged take")

        recorder.uploadOverride = { _ in
            XCTFail("even includeRetired must refuse a verdict-retired take")
            return ""
        }
        _ = await recorder.retryPending(includeRetired: true)
        XCTAssertTrue(audioExists("judged"))
    }

    /// A 4xx IS the server's verdict on this audio (bad format, too big), so it
    /// counts — otherwise a permanently unacceptable file nags forever.
    @MainActor
    func testServerRejectionRetiresAfterTwoVerdicts() async {
        let recorder = VoiceRecorder(store: store)
        let url = store.newRecordingURL(id: "rejected")
        try! Data(repeating: 5, count: 2_000).write(to: url)
        store.preserve(id: "rejected", reason: "transcribe-failed")
        recorder.uploadOverride = { _ in
            throw APIError.server(status: 400, code: "bad_request",
                                  message: "format must be one of…", serverHash: nil, serverContent: nil)
        }

        _ = await recorder.retryPending()
        XCTAssertEqual(recorder.pendingCount, 1, "one rejection still earns a retry")
        _ = await recorder.retryPending()

        XCTAssertEqual(recorder.failedCount, 1)
        XCTAssertEqual(store.pending().first?.lastErrorKind, .rejected)
        XCTAssertTrue(audioExists("rejected"))
    }

    /// `discardPending` and `discardFailed` own disjoint sets: the two rows talk
    /// about different recordings, so one row's button must not sweep away the
    /// other's.
    @MainActor
    func testDiscardButtonsAreScopedToTheirOwnRow() {
        let recorder = VoiceRecorder(store: store)
        for id in ["waiting", "doomed"] {
            let url = store.newRecordingURL(id: id)
            try! Data(repeating: 6, count: 2_000).write(to: url)
        }
        store.preserve(id: "waiting", reason: "transcribe-failed")
        store.noteAttempt(id: "doomed", reason: "transcribe-failed", kind: .empty, message: "no speech")
        store.noteAttempt(id: "doomed", reason: "transcribe-failed", kind: .empty, message: "no speech")
        recorder.refreshPending()
        XCTAssertEqual(recorder.pendingCount, 1)
        XCTAssertEqual(recorder.failedCount, 1)

        recorder.discardPending()
        XCTAssertFalse(audioExists("waiting"))
        XCTAssertTrue(audioExists("doomed"), "the pending row's trash must not touch the retired row's audio")

        recorder.discardFailed()
        XCTAssertFalse(audioExists("doomed"))
    }

    // MARK: - Cancellation is never silent on a user tap

    /// The Retry button could be a complete no-op: a cancelled upload set no
    /// errorMessage at all, so the row stayed, nothing moved, and nothing said
    /// why. A tap always gets an answer; lifecycle teardown of a live take still
    /// stays quiet (see `testCancelledUploadPreservesWithoutErrorUI`).
    @MainActor
    func testCancelledRetryTellsTheUserSomethingHappened() async {
        let recorder = VoiceRecorder(store: store)
        let url = store.newRecordingURL(id: "torn")
        try! Data(repeating: 7, count: 2_000).write(to: url)
        store.preserve(id: "torn", reason: "transcribe-failed")
        recorder.uploadOverride = { _ in throw CancellationError() }

        let text = await recorder.retryPending()

        XCTAssertNil(text)
        XCTAssertEqual(recorder.errorMessage, "Retry interrupted — recording kept")
        XCTAssertTrue(audioExists("torn"))
        XCTAssertEqual(recorder.pendingCount, 1, "a cancellation is not a verdict — it stays retryable")
    }

    // MARK: - Automatic drain

    /// `resumeForForeground()` was an EMPTY BODY: a take saved during an outage
    /// waited for a human to notice a banner and tap Retry, forever. Foregrounding
    /// now drains, and the recovered text goes to `onDrainedText` — the channel
    /// the composer wires to the DRAFT, never to auto-send.
    @MainActor
    func testForegroundDrainRecoversWithoutAnyTapAndLandsInTheDraftChannel() async {
        let recorder = ownedRecorder()
        let url = store.newRecordingURL(id: "waited")
        try! Data(repeating: 8, count: 2_000).write(to: url)
        store.preserve(id: "waited", reason: "transcribe-failed", surface: "tab:chat")
        recorder.refreshPending()
        recorder.uploadOverride = { _ in "words from the outage" }

        let drained = expectation(description: "drain hands text to the draft channel")
        var viaDraft: String?
        recorder.onDrainedText = { text in
            viaDraft = text
            drained.fulfill()
        }
        recorder.onAutoStopText = { _ in
            XCTFail("a drained take must never reach the auto-send channel")
        }

        recorder.resumeForForeground()

        await fulfillment(of: [drained], timeout: 5)
        XCTAssertEqual(viaDraft, "words from the outage")
        XCTAssertFalse(audioExists("waited"), "recovered audio is deleted like any success")
        XCTAssertEqual(recorder.pendingCount, 0)
    }

    /// A flapping connection produces an online/offline/online burst, and every
    /// edge is a drain trigger. Without the cooldown that is the same audio
    /// uploaded three times on cellular data for one wobble.
    @MainActor
    func testAutoDrainIsRateLimitedButRecoversAfterTheCooldown() async {
        let recorder = ownedRecorder()
        let url = store.newRecordingURL(id: "flapping")
        try! Data(repeating: 1, count: 2_000).write(to: url)
        store.preserve(id: "flapping", reason: "transcribe-failed", surface: "tab:chat")
        let t0 = Date(timeIntervalSince1970: 5_000)

        var uploads = 0
        recorder.uploadOverride = { _ in
            uploads += 1
            throw APIError.server(status: 503, code: "stt_unavailable",
                                  message: "still down", serverHash: nil, serverContent: nil)
        }
        recorder.drainPending(trigger: "reconnected", now: t0)
        // Poll on the UPLOAD COUNT, not on `state`: `drainPending` only schedules
        // the Task, so the recorder is still `.idle` on the next line and a
        // `while state != .idle` wait falls straight through without waiting.
        for _ in 0..<80 where uploads == 0 {
            try? await Task.sleep(for: .milliseconds(25))
        }
        XCTAssertEqual(uploads, 1, "the first edge really does drain")
        for _ in 0..<80 where recorder.state != .idle {
            try? await Task.sleep(for: .milliseconds(25))
        }

        // Two more edges inside the window: no new uploads.
        recorder.drainPending(trigger: "reconnected", now: t0.addingTimeInterval(2))
        recorder.drainPending(trigger: "reconnected", now: t0.addingTimeInterval(5))
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(uploads, 1, "a flap must not re-upload the same audio per edge")

        // Past the cooldown the take is retried for real — the rate limit must
        // not become the reason a recording never transcribes.
        let recovered = expectation(description: "post-cooldown drain recovers")
        recorder.onDrainedText = { _ in recovered.fulfill() }
        recorder.uploadOverride = { _ in
            uploads += 1
            return "back online"
        }
        recorder.drainPending(
            trigger: "reconnected",
            now: t0.addingTimeInterval(VoiceRecorder.autoDrainCooldown + 1)
        )
        await fulfillment(of: [recovered], timeout: 5)
        XCTAssertEqual(uploads, 2)
        XCTAssertFalse(audioExists("flapping"))
    }

    /// The drain must not wake up for takes it cannot help — a retired take is
    /// not "pending" and re-uploading it is the loop this whole fix removes.
    @MainActor
    func testDrainIgnoresRetiredTakes() async {
        let recorder = ownedRecorder()
        let url = store.newRecordingURL(id: "done")
        try! Data(repeating: 9, count: 2_000).write(to: url)
        store.noteAttempt(id: "done", reason: "transcribe-failed", kind: .empty, message: "no speech")
        store.noteAttempt(id: "done", reason: "transcribe-failed", kind: .empty, message: "no speech")
        recorder.uploadOverride = { _ in
            XCTFail("nothing to drain")
            return ""
        }

        recorder.drainPending(trigger: "test")
        // Give any (wrongly) scheduled Task a chance to run before asserting.
        try? await Task.sleep(for: .milliseconds(100))

        XCTAssertEqual(recorder.state, .idle)
        XCTAssertNil(recorder.errorMessage, "an automatic drain does not throw notices at anyone")
        XCTAssertTrue(audioExists("done"))
    }

    // MARK: - Ownership: a drain must not teleport text between surfaces

    /// THE CROSS-SURFACE TELEPORT (verifier finding F5). Every `ComposerBar` owns
    /// its own `@State VoiceRecorder` while the recording directory is
    /// process-global, and the new automatic drain triggers were not gated on who
    /// the take belonged to. A session composer's `disabled` flips at every turn
    /// boundary, so opening any session silently transcribed a dictation spoken
    /// into the Chat tab and appended it to THAT session's draft, with no tap
    /// anywhere. Words appearing in a conversation the user never spoke them into
    /// is worse than words waiting in a banner.
    @MainActor
    func testAutomaticDrainRefusesATakeSpokenIntoAnotherSurface() async {
        let sessionComposer = ownedRecorder(surface: "session:abc123", ownsOrphans: false)
        let url = store.newRecordingURL(id: "spoken-into-chat")
        try! Data(repeating: 1, count: 2_000).write(to: url)
        store.preserve(id: "spoken-into-chat", reason: "transcribe-failed", surface: "tab:chat")

        XCTAssertFalse(
            sessionComposer.ownsForAutomaticDrain(store.pending()[0]),
            "a session composer owns nothing that was spoken into the chat tab"
        )
        sessionComposer.uploadOverride = { _ in
            XCTFail("a session composer must not transcribe the chat tab's recording")
            return "teleported"
        }
        sessionComposer.onDrainedText = { _ in XCTFail("…and must not append it to its own draft") }

        sessionComposer.drainPending(trigger: "reconnected")
        try? await Task.sleep(for: .milliseconds(150))

        XCTAssertTrue(audioExists("spoken-into-chat"), "it stays where it belongs, still recoverable")

        // …and the composer it WAS spoken into drains it without any tap.
        let chatComposer = ownedRecorder(surface: "tab:chat")
        XCTAssertTrue(chatComposer.ownsForAutomaticDrain(store.pending()[0]))
        let landed = expectation(description: "the owning surface drains it")
        chatComposer.onDrainedText = { _ in landed.fulfill() }
        chatComposer.uploadOverride = { _ in "back where it belongs" }
        chatComposer.drainPending(trigger: "reconnected")
        await fulfillment(of: [landed], timeout: 5)
        XCTAssertFalse(audioExists("spoken-into-chat"))
    }

    /// A take preserved by a build that predates the origin stamp has no surface at
    /// all. Exactly ONE composer may adopt it, or it is drained by everybody (the
    /// teleport again) or by nobody (a permanent banner). The quick-action composer
    /// is the adopter because it is the surface the Home-screen shortcut talks to.
    @MainActor
    func testAnUnstampedTakeIsAdoptedOnlyByTheQuickActionComposer() {
        let url = store.newRecordingURL(id: "legacy-orphan")
        try! Data(repeating: 2, count: 2_000).write(to: url)
        store.preserve(id: "legacy-orphan", reason: "transcribe-failed")
        let orphan = store.pending()[0]
        XCTAssertNil(orphan.surface, "a pre-stamp sidecar carries no origin")

        let quickActionComposer = ownedRecorder(surface: "tab:chat", ownsOrphans: true)
        let sessionComposer = ownedRecorder(surface: "session:xyz", ownsOrphans: false)
        XCTAssertTrue(quickActionComposer.ownsForAutomaticDrain(orphan))
        XCTAssertFalse(sessionComposer.ownsForAutomaticDrain(orphan))

        // And a recorder nobody identified owns nothing at all — an unnamed
        // composer must never become a second adopter by accident.
        let anonymous = VoiceRecorder(store: store)
        XCTAssertFalse(anonymous.ownsForAutomaticDrain(orphan))
        let stampedURL = store.newRecordingURL(id: "stamped")
        try! Data(repeating: 3, count: 2_000).write(to: stampedURL)
        store.preserve(id: "stamped", reason: "transcribe-failed", surface: "tab:chat")
        let stamped = try! XCTUnwrap(store.pending().first { $0.id == "stamped" })
        XCTAssertFalse(anonymous.ownsForAutomaticDrain(stamped),
                       "an empty surface must not match a stamped take either")
    }

    /// The ownership rule is deliberately asymmetric, and this pins the half that
    /// keeps recovery possible: a MANUAL Retry works whatever the visible row is
    /// offering, because a person is looking at that row and asked for it. Making
    /// both paths strict would strand a take whose original surface is gone (the
    /// session was deleted) behind a banner with no button that helps.
    @MainActor
    func testManualRetryStillCrossesSurfacesBecauseAHumanAsked() async {
        let sessionComposer = ownedRecorder(surface: "session:abc123", ownsOrphans: false)
        let url = store.newRecordingURL(id: "from-chat")
        try! Data(repeating: 3, count: 2_000).write(to: url)
        store.preserve(id: "from-chat", reason: "transcribe-failed", surface: "tab:chat")
        sessionComposer.uploadOverride = { _ in "recovered by hand" }

        let text = await sessionComposer.retryPending()

        XCTAssertEqual(text, "recovered by hand",
                       "a Retry tap is the human back in the loop, so it is allowed")
        XCTAssertFalse(audioExists("from-chat"))
    }

    /// SINGLE-FLIGHT ACROSS INSTANCES (the second half of F5). Two mounted
    /// composers each hold their own recorder, so an instance-local "am I already
    /// draining" flag is invisible to the sibling: both could upload the same file
    /// and the winner would `markTranscribed` it out from under the loser. The
    /// claim therefore lives on the STORE, where the contention is.
    @MainActor
    func testTwoComposersCannotDrainTheSameTakeAtOnce() async {
        let first = ownedRecorder(surface: "tab:chat")
        let second = ownedRecorder(surface: "tab:chat")
        let url = store.newRecordingURL(id: "contested")
        try! Data(repeating: 4, count: 2_000).write(to: url)
        store.preserve(id: "contested", reason: "transcribe-failed", surface: "tab:chat")

        var uploads = 0
        let uploading = expectation(description: "the first composer is mid-upload")
        first.uploadOverride = { _ in
            uploads += 1
            uploading.fulfill()
            // Hold the upload open, yielding the MainActor, which is exactly the
            // window a sibling composer's drain trigger lands in.
            try? await Task.sleep(for: .milliseconds(400))
            return "uploaded once"
        }
        second.uploadOverride = { _ in
            uploads += 1
            XCTFail("the same audio must never be uploaded by two composers at once")
            return "duplicate"
        }

        async let firstResult = first.retryPending()
        await fulfillment(of: [uploading], timeout: 5)
        let secondResult = await second.retryPending()
        // Bound before asserting: `XCTAssertEqual` takes autoclosures, and an
        // `async let` cannot be captured by one.
        let firstText = await firstResult

        XCTAssertNil(secondResult, "the store-level claim refuses a sibling instance")
        XCTAssertEqual(firstText, "uploaded once")
        XCTAssertEqual(uploads, 1)
        XCTAssertFalse(audioExists("contested"))
    }

    /// The other side of the claim, and the last silent no-op left: a Retry TAP that
    /// arrives while a sibling composer is mid-upload loses the claim and used to
    /// return nil having said nothing at all. Bounded by the upload timeout, so it
    /// was never a wedge — but "I tapped and nothing happened" is the report this
    /// whole fix exists to answer.
    @MainActor
    func testALostDrainClaimStillAnswersATap() async {
        let holder = ownedRecorder()
        let tapper = ownedRecorder()
        let url = store.newRecordingURL(id: "held")
        try! Data(repeating: 1, count: 2_000).write(to: url)
        store.preserve(id: "held", reason: "transcribe-failed", surface: "tab:chat")

        let uploading = expectation(description: "the holder is mid-upload")
        holder.uploadOverride = { _ in
            uploading.fulfill()
            try? await Task.sleep(for: .milliseconds(400))
            return "the holder wins"
        }
        tapper.uploadOverride = { _ in
            XCTFail("the second tap must not upload")
            return ""
        }

        async let held = holder.retryPending()
        await fulfillment(of: [uploading], timeout: 5)
        let tapped = await tapper.retryPending()
        let heldText = await held

        XCTAssertNil(tapped)
        XCTAssertEqual(tapper.errorMessage, "Another upload is in progress — try again in a moment",
                       "a tap must never look like nothing happened")
        XCTAssertEqual(heldText, "the holder wins")
        // The AUTOMATIC path stays silent about the very same refusal.
        VoiceRecordingStore._testResetDrainGate()
        let quiet = ownedRecorder()
        let blocker = ownedRecorder()
        let url2 = store.newRecordingURL(id: "held2")
        try! Data(repeating: 2, count: 2_000).write(to: url2)
        store.preserve(id: "held2", reason: "transcribe-failed", surface: "tab:chat")
        let uploading2 = expectation(description: "the blocker is mid-upload")
        blocker.uploadOverride = { _ in
            uploading2.fulfill()
            try? await Task.sleep(for: .milliseconds(300))
            return "blocker"
        }
        async let blocked = blocker.retryPending()
        await fulfillment(of: [uploading2], timeout: 5)
        _ = await quiet.retryPending(userInitiated: false)
        XCTAssertNil(quiet.errorMessage, "an automatic drain that loses the claim says nothing")
        _ = await blocked
    }

    /// The claim must be RELEASED, not merely taken — a drain that failed while
    /// holding it would otherwise wedge every future drain in the process, which
    /// is a worse permanent banner than the one being fixed.
    @MainActor
    func testAFailedDrainReleasesTheClaimForTheNextOne() async {
        let recorder = ownedRecorder()
        let url = store.newRecordingURL(id: "twice")
        try! Data(repeating: 5, count: 2_000).write(to: url)
        store.preserve(id: "twice", reason: "transcribe-failed", surface: "tab:chat")
        recorder.uploadOverride = { _ in
            throw APIError.server(status: 503, code: "stt_unavailable",
                                  message: "down", serverHash: nil, serverContent: nil)
        }
        _ = await recorder.retryPending()

        recorder.uploadOverride = { _ in "the next attempt gets through" }
        let text = await recorder.retryPending()
        XCTAssertEqual(text, "the next attempt gets through")
    }

    // MARK: - Volume: an automatic drain must not nag

    /// F2. `note()` used to assign `errorMessage` for every failure regardless of
    /// what triggered the attempt, so every foreground while the Mac slept popped
    /// the mic-slash notice row at someone who had asked for nothing. The same
    /// failure on a Retry TAP must still speak — a tap that looks like a no-op is
    /// the other half of the original report.
    @MainActor
    func testAutomaticDrainFailureIsSilentWhileAManualRetryIsLoud() async {
        let recorder = ownedRecorder()
        let url = store.newRecordingURL(id: "sleeping-mac")
        try! Data(repeating: 6, count: 2_000).write(to: url)
        store.preserve(id: "sleeping-mac", reason: "transcribe-failed", surface: "tab:chat")
        recorder.uploadOverride = { _ in
            throw APIError.server(status: 503, code: "stt_unavailable",
                                  message: "bridge offline", serverHash: nil, serverContent: nil)
        }

        recorder.onDrainedText = { _ in XCTFail("nothing was recovered") }
        recorder.drainPending(trigger: "foreground")
        // The drain is fire-and-forget, so wait on the state it actually changes
        // (the sidecar's attempt count) rather than on `state`, which is still
        // `.idle` on the very next line because the Task has only been scheduled.
        for _ in 0..<120 where store.pending().first?.attempts == 0 {
            try? await Task.sleep(for: .milliseconds(25))
        }

        XCTAssertEqual(store.pending().first?.attempts, 1, "the attempt really happened")
        XCTAssertNil(recorder.errorMessage,
                     "an unrequested drain must not pop a notice: \(recorder.errorMessage ?? "")")
        XCTAssertEqual(recorder.pendingCount, 1, "the row still counts it, which is the honest signal")

        // Now the user taps Retry against the same dead server.
        let text = await recorder.retryPending()
        XCTAssertNil(text)
        XCTAssertNotNil(recorder.errorMessage, "a tap must never look like nothing happened")
    }

    /// "Silent" cuts both ways, and the second direction is easy to miss: an
    /// automatic drain must not ERASE the notice from the Retry the user actually
    /// tapped either. Clearing is a visible change made on a foreground nobody
    /// asked anything of. Only RECOVERY retracts it, because the words being in the
    /// draft is what makes "Voice unavailable" false.
    @MainActor
    func testAnAutomaticDrainNeitherRaisesNorErasesANotice() async {
        let recorder = ownedRecorder()
        let url = store.newRecordingURL(id: "unread-notice")
        try! Data(repeating: 9, count: 2_000).write(to: url)
        store.preserve(id: "unread-notice", reason: "transcribe-failed", surface: "tab:chat")
        recorder.uploadOverride = { _ in
            throw APIError.server(status: 503, code: "stt_unavailable",
                                  message: "bridge offline", serverHash: nil, serverContent: nil)
        }

        // The user taps Retry and gets a sentence.
        _ = await recorder.retryPending()
        let notice = recorder.errorMessage
        XCTAssertNotNil(notice)

        // A foreground arrives. Same dead server, so nothing improved.
        let t0 = Date(timeIntervalSince1970: 9_000)
        recorder.drainPending(trigger: "foreground", now: t0)
        for _ in 0..<120 where store.pending().first?.attempts == 1 {
            try? await Task.sleep(for: .milliseconds(25))
        }
        XCTAssertEqual(store.pending().first?.attempts, 2, "the drain really ran")
        XCTAssertEqual(recorder.errorMessage, notice,
                       "an unrequested drain must leave the user's unread notice exactly as it was")

        // Now it works, past the cooldown. THAT retracts the notice.
        recorder.uploadOverride = { _ in "finally through" }
        let recovered = expectation(description: "the drain recovers the take")
        recorder.onDrainedText = { _ in recovered.fulfill() }
        recorder.drainPending(
            trigger: "reconnected",
            now: t0.addingTimeInterval(VoiceRecorder.autoDrainCooldown + 1)
        )
        await fulfillment(of: [recovered], timeout: 5)
        XCTAssertNil(recorder.errorMessage,
                     "the words are in the draft, so the notice has become false")
    }

    /// The one thing a silent drain IS still allowed to change: which row the take
    /// belongs to. "Transcription pending" becoming false is a correction to a
    /// claim the UI is making, not a complaint, so retirement must land even when
    /// nobody asked for the attempt.
    @MainActor
    func testASilentDrainStillRetiresTheTakeSoTheRowStopsLying() async {
        let recorder = ownedRecorder()
        let url = store.newRecordingURL(id: "one-verdict-in")
        try! Data(repeating: 7, count: 2_000).write(to: url)
        // One empty verdict already recorded: the next one retires it.
        store.noteAttempt(id: "one-verdict-in", reason: "transcribe-failed",
                          kind: .empty, message: "no speech")
        store.preserve(id: "one-verdict-in", reason: "transcribe-failed", surface: "tab:chat")
        recorder.refreshPending()
        XCTAssertEqual(recorder.pendingCount, 1)
        recorder.uploadOverride = { _ in "" }

        recorder.drainPending(trigger: "foreground")
        for _ in 0..<120 where recorder.failedCount == 0 {
            try? await Task.sleep(for: .milliseconds(25))
        }

        XCTAssertEqual(recorder.pendingCount, 0, "it must stop claiming a transcription is pending")
        XCTAssertEqual(recorder.failedCount, 1, "the retired row is the correction")
        XCTAssertNil(recorder.errorMessage, "…delivered as row state, not as a notice")
        XCTAssertTrue(audioExists("one-verdict-in"), "and never at the cost of the audio")
    }

    // MARK: - The server's verdict on the audio (422 bad_audio)

    /// F6, and the reason `attemptCeiling` had to exist. An m4a whose recording was
    /// killed before AVAudioRecorder wrote the `moov` atom is unreadable forever,
    /// and the route used to report that as `503 stt_unavailable` — transport by
    /// every signal the phone has — so the take ground through all SIX attempts
    /// before it could leave "pending".
    ///
    /// `422 bad_audio` gets its own class (`.damaged`) rather than joining the other
    /// 4xx, and it is final on the FIRST answer. The two-verdict courtesy exists
    /// because an engine can change its mind between attempts (the Mac reconnects
    /// and a local model hears the speech the cloud fallback missed); "this
    /// container is truncated" is not a mind that can be changed. Six attempts
    /// became one.
    @MainActor
    func testDamagedRecordingIsRetiredOnTheFirstVerdict() async {
        XCTAssertEqual(
            VoiceRetryPlan.classify(APIError.server(
                status: 422, code: "bad_audio", message: "That recording is damaged",
                serverHash: nil, serverContent: nil)),
            .damaged,
            "matched on the CODE, not the status, so a future 422 for another reason keeps its retry"
        )

        let recorder = ownedRecorder()
        let url = store.newRecordingURL(id: "no-moov")
        try! Data(repeating: 8, count: 2_000).write(to: url)
        store.preserve(id: "no-moov", reason: "transcribe-failed", surface: "tab:chat")
        var uploads = 0
        recorder.uploadOverride = { _ in
            uploads += 1
            throw APIError.server(
                status: 422, code: "bad_audio",
                message: "That recording is damaged and can't be transcribed",
                serverHash: nil, serverContent: nil)
        }

        _ = await recorder.retryPending()

        XCTAssertEqual(uploads, 1, "one attempt, not the six a 503 cost")
        XCTAssertEqual(recorder.pendingCount, 0, "it must stop claiming a transcription is pending")
        XCTAssertEqual(recorder.failedCount, 1)
        XCTAssertEqual(recorder.recoverableFailedCount, 0,
                       "the server read the file, so offering a Retry would be a lie")
        XCTAssertEqual(store.pending().first?.lastErrorKind, .damaged)
        XCTAssertEqual(recorder.errorMessage,
                       "That recording is damaged and can't be transcribed — Discard it",
                       "the retired copy must not advise keeping it 'for later' when later cannot help")
        XCTAssertTrue(audioExists("no-moov"), "a verdict is still not permission to delete")

        // And a second drain does not touch it again.
        recorder.uploadOverride = { _ in
            XCTFail("a damaged take must never be re-uploaded, even by an explicit Try again")
            return ""
        }
        _ = await recorder.retryPending(includeRetired: true)
        XCTAssertEqual(uploads, 1)
    }

    /// The counter-case that keeps `.damaged` narrow: an ordinary 4xx is still the
    /// server's opinion, and opinions get the second look. A cap or a validation
    /// rule can move under the same bytes; a truncated container cannot.
    @MainActor
    func testAnOrdinaryRejectionStillGetsItsSecondLook() async {
        XCTAssertEqual(
            VoiceRetryPlan.classify(APIError.server(
                status: 422, code: "unprocessable", message: "nope",
                serverHash: nil, serverContent: nil)),
            .rejected,
            "the status alone must not mean damaged — only the bad_audio code does"
        )
        XCTAssertEqual(VoiceRetryPlan.verdictCount(previous: 0, kind: .rejected), 1)
        XCTAssertEqual(VoiceRetryPlan.verdictCount(previous: 0, kind: .damaged),
                       VoiceRetryPlan.maxVerdicts,
                       "one damaged answer jumps straight to the cap, which is what makes it final")
        XCTAssertFalse(VoiceRetryPlan.retryStillPlausible(
            verdicts: VoiceRetryPlan.verdictCount(previous: 0, kind: .damaged)))
    }

    // MARK: - Sidecar compatibility

    /// v1 sidecars are already on users' phones. The v2 decoder MUST read them,
    /// and this test is the ratchet on the trap: Swift's SYNTHESIZED `Decodable`
    /// throws on a missing key even when the property has a default value, so a
    /// synthesized decoder would fail on every one of these — and `readSidecar`
    /// swallows the error, so the damage would be quiet: every preserved take
    /// losing its age and reason and reappearing as `reason: "unknown"`.
    func testV1SidecarStillDecodesWithDefaultedV2Fields() {
        struct SidecarV1: Encodable {
            var v = 1
            var createdAt: Date
            var reason: String
        }
        let url = store.newRecordingURL(id: "legacy")
        try! Data(repeating: 1, count: 2_000).write(to: url)
        let created = Date(timeIntervalSince1970: 1_700_000_000)
        let data = try! JSONEncoder().encode(SidecarV1(createdAt: created, reason: "interrupted"))
        try! data.write(to: tempDir.appendingPathComponent("legacy.json"))

        let rec = store.pending().first
        XCTAssertEqual(rec?.id, "legacy")
        XCTAssertEqual(rec?.reason, "interrupted", "a v1 sidecar must not degrade to 'unknown'")
        XCTAssertEqual(rec?.createdAt.timeIntervalSince1970 ?? 0,
                       created.timeIntervalSince1970, accuracy: 0.01)
        XCTAssertEqual(rec?.attempts, 0, "new fields default rather than failing the decode")
        XCTAssertEqual(rec?.verdicts, 0)
        XCTAssertNil(rec?.lastErrorKind)
        XCTAssertFalse(rec?.isTerminal ?? true, "a v1 take starts with all its retries")
    }

    /// Attempt bookkeeping survives a `preserve` from a path that knows nothing
    /// about attempts (a take re-preserved because the view went away). Resetting
    /// there would hand a retired take its retries back and revive the banner.
    func testPreserveKeepsAttemptBookkeeping() {
        let url = store.newRecordingURL(id: "counted")
        try! Data(repeating: 1, count: 2_000).write(to: url)
        store.noteAttempt(id: "counted", reason: "transcribe-failed", kind: .empty, message: "no speech")

        store.preserve(id: "counted", reason: "view-dismissed")

        let rec = store.pending().first
        XCTAssertEqual(rec?.reason, "view-dismissed", "the new reason wins")
        XCTAssertEqual(rec?.attempts, 1, "the count is carried over, not reset")
        XCTAssertEqual(rec?.verdicts, 1)
        XCTAssertEqual(rec?.lastErrorKind, .empty)
    }

    // MARK: - The retry rules themselves

    func testRetryPlanCountsOnlyVerdictsTowardRetirement() {
        XCTAssertFalse(VoiceRetryPlan.isTerminal(verdicts: 0, attempts: 0))
        XCTAssertFalse(VoiceRetryPlan.isTerminal(verdicts: 1, attempts: 1),
                       "one verdict still earns one honest retry")
        XCTAssertTrue(VoiceRetryPlan.isTerminal(verdicts: VoiceRetryPlan.maxVerdicts, attempts: 2))
        // The ceiling is the second, independent route out of "pending".
        XCTAssertFalse(VoiceRetryPlan.isTerminal(
            verdicts: 0, attempts: VoiceRetryPlan.attemptCeiling - 1))
        XCTAssertTrue(VoiceRetryPlan.isTerminal(
            verdicts: 0, attempts: VoiceRetryPlan.attemptCeiling))
        // …and only the ceiling route keeps a manual retry.
        XCTAssertTrue(VoiceRetryPlan.retryStillPlausible(verdicts: 0))
        XCTAssertFalse(VoiceRetryPlan.retryStillPlausible(verdicts: VoiceRetryPlan.maxVerdicts))

        XCTAssertEqual(VoiceRetryPlan.verdictCount(previous: 1, kind: .empty), 2)
        XCTAssertEqual(VoiceRetryPlan.verdictCount(previous: 1, kind: .rejected), 2)
        XCTAssertEqual(VoiceRetryPlan.verdictCount(previous: 1, kind: .transport), 1,
                       "an outage says nothing about the audio")
        XCTAssertEqual(VoiceRetryPlan.verdictCount(previous: 1, kind: .cancelled), 1)
        // `damaged` is the only kind that is final on its first answer, and it says
        // so by jumping to the cap rather than by carrying a separate flag that
        // `isTerminal` and `retryStillPlausible` would both have to agree with.
        XCTAssertTrue(VoiceRetryPlan.FailureKind.damaged.isFinalOnFirstVerdict)
        for kind in [VoiceRetryPlan.FailureKind.empty, .rejected, .transport, .cancelled] {
            XCTAssertFalse(kind.isFinalOnFirstVerdict, "\(kind) must keep its second look")
        }
        XCTAssertEqual(VoiceRetryPlan.verdictCount(previous: 0, kind: .damaged),
                       VoiceRetryPlan.maxVerdicts)
        XCTAssertEqual(VoiceRetryPlan.verdictCount(previous: VoiceRetryPlan.maxVerdicts, kind: .damaged),
                       VoiceRetryPlan.maxVerdicts, "and it never over-counts on a repeat")
    }

    func testRetryPlanClassifiesFailuresByWhoIsAtFault() {
        XCTAssertEqual(VoiceRetryPlan.classify(APIError.cancelled), .cancelled)
        XCTAssertEqual(VoiceRetryPlan.classify(CancellationError()), .transport,
                       "an unrecognized error must never be what retires a recording")
        XCTAssertEqual(
            VoiceRetryPlan.classify(APIError.server(
                status: 503, code: "stt_unavailable", message: "down",
                serverHash: nil, serverContent: nil)),
            .transport
        )
        XCTAssertEqual(
            VoiceRetryPlan.classify(APIError.server(
                status: 413, code: "too_large", message: "too big",
                serverHash: nil, serverContent: nil)),
            .rejected
        )
        XCTAssertEqual(VoiceRetryPlan.classify(APIError.notConfigured), .transport)
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
