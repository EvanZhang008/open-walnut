import XCTest
@testable import Walnut

/// A field's Retry and Discard operate only on the field's own recordings,
/// while the chat's recovery tray still offers the older global recovery path.
@MainActor
final class VoiceFieldRecoveryTests: XCTestCase {
    private var root: URL!
    private var store: VoiceRecordingStore!

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("voice-field-\(UUID().uuidString)")
        store = VoiceRecordingStore(baseDir: root)
        VoiceRecordingStore._testResetDrainGate()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
        VoiceRecordingStore._testResetDrainGate()
    }

    private func take(_ id: String, surface: String?) throws -> VoiceRecordingStore.Recording {
        let url = store.newRecordingURL(id: id)
        try Data(repeating: 0xAB, count: 4_000).write(to: url)
        try store.preserveOrThrow(id: id, reason: "transcribe-failed", surface: surface)
        return try XCTUnwrap(store.pending().first { $0.id == id })
    }

    func testFieldCountsAndRecoversOnlyItsOwnSurface() async throws {
        let own = try take("own", surface: "thread-follow-up:main/th-own")
        let other = try take("other", surface: "thread-follow-up:main/th-other")
        let orphan = try take("orphan", surface: nil)
        let voice = VoiceRecorder(store: store)
        voice.surface = "thread-follow-up:main/th-own"
        voice.restrictRecoveryToSurface = true
        voice.uploadOverride = { _ in "Recovered words" }
        XCTAssertTrue(voice.showsHere(own))
        XCTAssertFalse(voice.showsHere(other))
        XCTAssertFalse(voice.showsHere(orphan))
        let recovered = await voice.retryPending()
        XCTAssertEqual(recovered, "Recovered words")
        XCTAssertEqual(Set(store.pending().map(\.id)), Set(["other", "orphan"]))
    }

    func testFieldDiscardDoesNotRemoveAnotherFieldsTake() throws {
        _ = try take("own", surface: "task-note:one")
        _ = try take("other", surface: "task-note:two")
        let voice = VoiceRecorder(store: store)
        voice.surface = "task-note:one"
        voice.restrictRecoveryToSurface = true
        voice.discardPending()
        XCTAssertEqual(store.pending().map(\.id), ["other"])
    }

    private final class Capture: AudioCapture {
        var currentTime: TimeInterval = 2
        private(set) var stopped = false
        func stop() { stopped = true }
    }

    func testStartingAgainNeverReplacesAnActiveTakeOrTranscription() async throws {
        let voice = VoiceRecorder(store: store)
        voice.surface = "test:one"
        let id = "original"
        let url = store.newRecordingURL(id: id)
        try Data(repeating: 0xAB, count: 4_000).write(to: url)
        let capture = Capture()
        voice._testBeginTake(capture: capture, url: url, id: id)
        let startedAgain = await voice.start()
        XCTAssertFalse(startedAgain)
        XCTAssertEqual(voice.liveTakeID, id)
        XCTAssertFalse(capture.stopped)
        XCTAssertEqual(voice.state, .recording)

        var release: CheckedContinuation<String, Error>?
        voice.uploadOverride = { _ in try await withCheckedThrowingContinuation { release = $0 } }
        let finish = Task { await voice.stopAndTranscribe() }
        for _ in 0..<200 where release == nil { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertNotNil(release)
        let duringUpload = await voice.start()
        XCTAssertFalse(duringUpload)
        XCTAssertEqual(voice.state, .transcribing)
        release?.resume(returning: "Original take")
        let words = await finish.value
        XCTAssertEqual(words, "Original take")
        XCTAssertTrue(voice.canStart)
    }

    func testChatRecoveryStillOffersOtherAndOrphanedTakesButNotTalk() throws {
        let other = try take("other", surface: "task-note:two")
        let orphan = try take("orphan", surface: nil)
        let talk = try take("talk", surface: VoiceRecorder.talkSurface)
        let chat = VoiceRecorder(store: store)
        chat.surface = "tab:chat"
        chat.ownsOrphanTakes = true
        XCTAssertTrue(chat.showsHere(other))
        XCTAssertTrue(chat.showsHere(orphan))
        XCTAssertFalse(chat.showsHere(talk))
    }
}
