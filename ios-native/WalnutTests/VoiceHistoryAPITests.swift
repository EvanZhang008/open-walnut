import CryptoKit
import XCTest
@testable import Walnut

@MainActor
final class VoiceHistoryAPITests: XCTestCase {
    private var savedURL: URL?
    private var savedToken: String?
    private var directory: URL!

    override func setUp() async throws {
        LifecycleHub.shared.teardownAll()
        savedURL = AppConfig.processServerURLOverride
        savedToken = AppConfig.processTokenOverride
        AppConfig.processServerURLOverride = DemoMode.baseURL
        AppConfig.processTokenOverride = DemoMode.token
        DemoServer.shared.latencyScale = 0
        DemoServer.shared.reset()
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
        DemoServer.shared.reset()
        DemoServer.shared.latencyScale = 1
        AppConfig.processServerURLOverride = savedURL
        AppConfig.processTokenOverride = savedToken
    }

    func testSevenMinuteAudioIsChunkedCommittedAndRetainedWithText() async throws {
        let store = VoiceRecordingStore(baseDir: directory)
        let id = UUID().uuidString
        let url = store.newRecordingURL(id: id)
        let audio = Data(repeating: 0x3a, count: 420 * 16_000 * 2)
        try audio.write(to: url)
        XCTAssertTrue(store.preserve(id: id, reason: "recorded", surface: "tab:chat"))
        try store.noteDuration(id: id, duration: 420)
        let record = try XCTUnwrap(store.recording(id: id))
        let api = WalnutAPI()
        let remote = try await api.archiveVoice(audioURL: url, recording: record)
        XCTAssertEqual(remote.id, id.lowercased())
        XCTAssertEqual(remote.audioSizeBytes, audio.count)
        XCTAssertEqual(remote.audioSha256, SHA256.hash(data: audio).map { String(format: "%02x", $0) }.joined())
        let result = try await api.transcribeVoice(audioURL: url, recording: record)
        XCTAssertFalse(result.text.isEmpty)
        try store.saveTranscription(id: id, text: result.text)
        let relaunched = VoiceRecordingStore(baseDir: directory)
        XCTAssertEqual(relaunched.history().first?.transcript, result.text)
        XCTAssertEqual(try Data(contentsOf: url), audio)
        let page = try await api.voiceHistory()
        XCTAssertEqual(page.recordings.first?.text, result.text)
        let repeated = try await api.transcribeVoice(audioURL: url, recording: relaunched.recording(id: id)!)
        XCTAssertEqual(repeated.text, result.text)
        let finalPage = try await api.voiceHistory()
        XCTAssertEqual(finalPage.recordings.count, 1)
    }

    func testLocalAndRemoteHistoryMergeWithoutLosingTranscriptOnlyRows() throws {
        let store = VoiceRecordingStore(baseDir: directory)
        let id = UUID().uuidString
        let url = store.newRecordingURL(id: id)
        try Data([1, 2, 3]).write(to: url)
        store.preserve(id: id, reason: "recorded")
        let text = String(repeating: "\u{8BB0}\u{5F55} with Unicode \u{1F642} and code. ", count: 200)
        try store.saveTranscription(id: id, text: text)
        try FileManager.default.removeItem(at: url)
        let json = """
        {"id":"\(id.lowercased())","createdAt":"2026-10-11T07:30:00Z","format":"caf","audioSizeBytes":3,"state":"transcribed","primarySaved":false}
        """
        let remote = try JSONDecoder().decode(VoiceArchiveRecord.self, from: Data(json.utf8))
        let entries = VoiceHistoryEntry.merge(local: store.history(), remote: [remote])
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries.first?.text, text)
        XCTAssertNil(entries.first?.audioURL)
        XCTAssertTrue(entries.first!.status.contains("Mac copy pending"))
    }

    func testPrimaryOnlyBackupNeverClaimsACompanionCopy() throws {
        let store = VoiceRecordingStore(baseDir: directory)
        let id = UUID().uuidString
        try Data([1]).write(to: store.newRecordingURL(id: id))
        try store.markBackup(id: id, serverID: id, primarySaved: true, storage: "primary")
        let entry = VoiceHistoryEntry(id: id, local: store.recording(id: id), remote: nil)
        XCTAssertEqual(entry.status, "Saved on iPhone and Mac. Cloud copy pending.")
        XCTAssertEqual(VoiceRecordingStore(baseDir: directory).recording(id: id)?.archiveStorage, "primary")
        let json = """
        {"id":"\(id)","createdAt":"2026-10-11T07:30:00Z","format":"caf","audioSizeBytes":1,"state":"saved","primarySaved":true,"storage":"companion"}
        """
        let remote = try JSONDecoder().decode(VoiceArchiveRecord.self, from: Data(json.utf8))
        XCTAssertEqual(VoiceHistoryEntry(id: id, local: entry.local, remote: remote).status, "Saved on iPhone, server and Mac.")
    }

    func testDamagedAudioPlaybackKeepsItsFileAndReportsRecoveryOptions() async throws {
        let store = VoiceRecordingStore(baseDir: directory)
        let id = UUID().uuidString
        let url = store.newRecordingURL(id: id)
        try Data([1, 2, 3]).write(to: url)
        let model = VoiceHistoryDetailModel(entry: VoiceHistoryEntry(id: id, local: store.recording(id: id), remote: nil))
        await model.togglePlayback()
        XCTAssertFalse(model.playing)
        XCTAssertEqual(model.notice, "This recording could not be played. You can still export the saved audio.")
        model.stop()
        XCTAssertEqual(try Data(contentsOf: url), Data([1, 2, 3]))
    }

    func testLeavingDetailBeforePlaybackResumesNeverStartsAudio() async throws {
        let store = VoiceRecordingStore(baseDir: directory)
        let id = UUID().uuidString
        try Data([1]).write(to: store.newRecordingURL(id: id))
        let model = VoiceHistoryDetailModel(entry: VoiceHistoryEntry(id: id, local: store.recording(id: id), remote: nil))
        var release: CheckedContinuation<Void, Never>?
        var reached: CheckedContinuation<Void, Never>?
        var starts = 0
        model._testBeforePlayback = {
            await withCheckedContinuation { continuation in
                release = continuation
                reached?.resume()
            }
        }
        model._testPlaybackStart = { starts += 1 }
        let playback = Task { await model.togglePlayback() }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            if release != nil { continuation.resume() } else { reached = continuation }
        }
        model.stop()
        release?.resume()
        await playback.value
        XCTAssertEqual(starts, 0)
        XCTAssertFalse(model.playing)
    }

    func testCompletedDetailTranscriptAppearsWhenBackupStatusLookupFails() async throws {
        let store = VoiceRecordingStore(baseDir: directory)
        let id = UUID().uuidString
        let url = store.newRecordingURL(id: id)
        try Data([1, 2, 3]).write(to: url)
        store.preserve(id: id, reason: "recorded")
        let model = VoiceHistoryDetailModel(
            entry: VoiceHistoryEntry(id: id, local: store.recording(id: id), remote: nil), store: store
        )
        model._testRemoteRecord = { _, _ in throw APIError.badResponse }
        await model.transcribe()
        let saved = try XCTUnwrap(store.recording(id: id)?.transcript)
        XCTAssertFalse(saved.isEmpty)
        XCTAssertEqual(model.entry.text, saved)
        XCTAssertEqual(model.notice, "Backup status is unavailable. Saved recordings and text are still here.")
        XCTAssertEqual(try Data(contentsOf: url), Data([1, 2, 3]))
    }

    func testOpenDetailPicksUpRecoveredTextAndBackupState() async throws {
        let store = VoiceRecordingStore(baseDir: directory)
        let id = UUID().uuidString
        try Data([1]).write(to: store.newRecordingURL(id: id))
        store.preserve(id: id, reason: "recorded")
        let model = VoiceHistoryDetailModel(
            entry: VoiceHistoryEntry(id: id, local: store.recording(id: id), remote: nil), store: store
        )
        try store.saveRecoveredTranscription(id: id, text: "Recovered words")
        try store.markBackup(id: id, serverID: id, primarySaved: true, storage: "companion")
        model._testRemoteRecord = { _, _ in throw APIError.badResponse }
        await model.refresh()
        XCTAssertEqual(model.entry.text, "Recovered words")
        XCTAssertEqual(model.entry.status, "Saved on iPhone, server and Mac.")
        XCTAssertEqual(model.notice, "Backup status is unavailable. Saved recordings and text are still here.")
        model._testRemoteRecord = { _, _ in
            VoiceArchiveRecord(id: id, createdAt: "2026-10-11T07:30:00Z", format: "caf",
                durationSeconds: nil, surface: nil, audioSizeBytes: 1, audioSha256: nil,
                text: "Recovered words", via: nil, state: "transcribed", primarySaved: true,
                storage: "companion")
        }
        await model.refresh()
        XCTAssertEqual(model.entry.text, "Recovered words")
        XCTAssertNil(model.notice)
    }

    func testSyncRefreshPreservesEarlierRemotePagesAndTheirCursor() async throws {
        let model = VoiceHistoryModel(store: VoiceRecordingStore(baseDir: directory))
        func record(_ id: String, _ second: Int, _ text: String) -> VoiceArchiveRecord {
            VoiceArchiveRecord(id: id, createdAt: String(format: "2026-10-11T07:30:%02dZ", second),
                format: "caf", durationSeconds: 10, surface: nil, audioSizeBytes: 1,
                audioSha256: nil, text: text, via: nil, state: "transcribed", primarySaved: true)
        }
        model._testPage = { cursor in
            if cursor == "page-two" {
                return VoiceArchivePage(recordings: [record("b", 20, "Earlier text")], nextBefore: "page-three")
            }
            return VoiceArchivePage(recordings: [record("a", 30, "First text")], nextBefore: "page-two")
        }
        await model.refresh()
        await model.refresh(more: true)
        XCTAssertEqual(model.entries.map(\.id), ["a", "b"])
        XCTAssertEqual(model.nextBefore, "page-three")
        model._testPage = { _ in
            VoiceArchivePage(recordings: [record("a", 30, "Updated text")], nextBefore: "page-two")
        }
        await model.refresh(preservingLoaded: true)
        XCTAssertEqual(model.entries.map(\.id), ["a", "b"])
        XCTAssertEqual(model.entries.first?.text, "Updated text")
        XCTAssertEqual(model.nextBefore, "page-three")
    }

    func testRemoteHistoryParsesFractionalSecondsAndKeepsDateOrder() throws {
        let json = """
        [{"id":"b","createdAt":"2026-10-11T07:31:52.985Z","format":"caf","audioSizeBytes":3,"state":"saved"},
         {"id":"a","createdAt":"2026-10-11T07:22:33.678Z","format":"caf","audioSizeBytes":3,"state":"saved"}]
        """
        let remote = try JSONDecoder().decode([VoiceArchiveRecord].self, from: Data(json.utf8))
        let entries = VoiceHistoryEntry.merge(local: [], remote: Array(remote.reversed()))
        XCTAssertEqual(entries.map(\.id), ["b", "a"])
        XCTAssertGreaterThan(entries[0].createdAt.timeIntervalSince1970, 1_790_000_000)
    }
}
