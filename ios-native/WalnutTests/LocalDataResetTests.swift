import Foundation
import XCTest
@testable import Walnut

/// Disconnect (and Leave demo) must leave nothing behind: every store that keeps
/// data on this phone is seeded here, the reset runs, and each one is checked
/// empty. Preferences, tmp and Documents are pointed at scratch locations so the
/// test cannot wipe the host app's own settings; the stores below use their real
/// locations, exactly as a disconnect sees them.
@MainActor
final class LocalDataResetTests: XCTestCase {
    struct Scratch {
        let root: URL
        let locations: LocalDataReset.Locations
        let suite: String
    }

    /// Real Application Support and Caches, scratch everything else.
    static func scratchLocations() throws -> Scratch {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("local-data-reset-\(UUID().uuidString)", isDirectory: true)
        let tmp = root.appendingPathComponent("tmp", isDirectory: true)
        let docs = root.appendingPathComponent("docs", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: docs, withIntermediateDirectories: true)
        let suite = "local-data-reset-\(UUID().uuidString)"
        let app = LocalDataReset.Locations.app
        return Scratch(
            root: root,
            locations: LocalDataReset.Locations(
                applicationSupport: app.applicationSupport, caches: app.caches,
                temporary: tmp, documents: docs,
                defaults: UserDefaults(suiteName: suite)!, defaultsDomain: suite
            ),
            suite: suite
        )
    }

    private func waitFor(_ timeout: TimeInterval, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(25))
        }
        return condition()
    }

    func testEveryLocalStoreIsEmptyAfterTheReset() async throws {
        let scratch = try Self.scratchLocations()
        defer { try? FileManager.default.removeItem(at: scratch.root) }
        let fm = FileManager.default
        let support = scratch.locations.applicationSupport
        let caches = scratch.locations.caches
        let marker = "reset-marker-\(UUID().uuidString)"

        // In-memory stores (the ones the app registers at launch).
        let saved = LocalDataReset.registrationForTesting
        defer { LocalDataReset.registrationForTesting = saved }
        let tasks = TasksStore()
        let chat = ChatStore()
        let notes = NotesStore()
        let inbox = InboxStore(defaults: UserDefaults(suiteName: scratch.suite)!)
        LocalDataReset.register(tasks: tasks, chat: chat, notes: notes, inbox: inbox, filePreview: nil)
        let seeded = DemoFixtures.seed()
        tasks.tasks = seeded.tasks.map(\.wire)
        tasks.sessions = seeded.sessions.map { seeded.wireSession($0) }
        tasks.taskFolders = seeded.wireFolders
        tasks.projectOrder = DemoFixtures.projectOrder
        chat.conversations = [ConversationSummary(id: "c1", title: marker, updatedAt: "2026-09-30T10:00:00Z", messageCount: 1)]
        chat.messages = [ChatMessage(id: "m1", role: "user", text: marker, createdAt: "2026-09-30T10:00:00Z", kind: nil)]
        chat.activeID = "c1"
        notes.tree = seeded.noteTree
        notes.pinned = ["Inbox.md"]
        inbox.letters = seeded.letters

        // Drafts: the composer and letter replies.
        ComposerDrafts.shared.setDraft(marker, key: "reset-test")
        LetterReplyStore.shared.setDraft(marker, for: "l-reset-test")

        // Unsent chat messages (the durable send queue) and disk caches.
        XCTAssertTrue(DurableStore.save([marker], key: "chat-send-queue"))
        DiskCache.save([marker], key: "reset-test-cache")
        let cacheLanded = await waitFor(3) { DiskCache.load([String].self, key: "reset-test-cache") != nil }
        XCTAssertTrue(cacheLanded)

        // Downloaded images and letter bodies.
        let attachments = caches.appendingPathComponent("WalnutAttachments", isDirectory: true)
        try fm.createDirectory(at: attachments, withIntermediateDirectories: true)
        try DemoImage.png.write(to: attachments.appendingPathComponent("seed.png"))
        let bodies = caches.appendingPathComponent("letter-bodies", isDirectory: true)
        try fm.createDirectory(at: bodies, withIntermediateDirectories: true)
        try Data("<p>\(marker)</p>".utf8).write(to: bodies.appendingPathComponent("l-1.html"))
        // A cache folder some later store adds: the sweep does not need a list.
        let futureCache = caches.appendingPathComponent("reset-test-future-cache", isDirectory: true)
        try fm.createDirectory(at: futureCache, withIntermediateDirectories: true)
        try Data(marker.utf8).write(to: futureCache.appendingPathComponent("entry.bin"))

        // Where each session stream left off (kept in memory and on disk).
        let streamKey = "https://demo.walnut.invalid/api/v1/sessions/s-reset/stream"
        SessionStreamResumeIDs.shared.save(42, for: streamKey)
        XCTAssertEqual(SessionStreamResumeIDs.shared.id(for: streamKey), 42)

        // A voice recording waiting to upload.
        let voice = VoiceRecordingStore()
        try Data(repeating: 1, count: 2_048).write(to: voice.newRecordingURL(id: "reset-take"))
        voice.preserve(id: "reset-take", reason: "offline")
        XCTAssertFalse(voice.pending().isEmpty)

        // Attention time that was never sent.
        let samples = TimeSampleStore()
        await samples.enqueue([AttentionSample(
            startMs: Int64(Date().timeIntervalSince1970 * 1000) - 120_000, durationMs: 60_000,
            kind: .chat, taskId: nil, sessionId: nil
        )])
        XCTAssertTrue(fm.fileExists(atPath: TimeSampleStore.defaultFileURL().path))

        // The diagnostic log.
        for _ in 0..<50 { AppLog.info("reset-test", marker, ["n": "1"]) }
        AppLog.shared.persistNow()
        let logFile = support.appendingPathComponent("walnut-applog.jsonl")
        XCTAssertTrue((try? String(contentsOf: logFile, encoding: .utf8))?.contains(marker) ?? false)

        // A stray file of some future store, tmp, Documents, preferences, HTTP cache.
        try Data(marker.utf8).write(to: support.appendingPathComponent("reset-test-stray.bin"))
        try Data(marker.utf8).write(to: scratch.locations.temporary.appendingPathComponent("picked.jpg"))
        try Data(marker.utf8).write(to: scratch.locations.documents.appendingPathComponent("export.txt"))
        scratch.locations.defaults.set(marker, forKey: "walnut.someFilter")
        let cachedURL = URL(string: "https://demo.walnut.invalid/api/v1/tasks")!
        URLCache.shared.storeCachedResponse(
            CachedURLResponse(
                response: HTTPURLResponse(url: cachedURL, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                data: Data(marker.utf8)
            ),
            for: URLRequest(url: cachedURL)
        )

        // --- The reset ---
        let removed = LocalDataReset.eraseAll(reason: "test", locations: scratch.locations)
        await TimeHeartbeatReporter.shared.drainForTesting()

        // In-memory stores.
        XCTAssertTrue(tasks.tasks.isEmpty)
        XCTAssertTrue(tasks.sessions.isEmpty)
        XCTAssertTrue(tasks.taskFolders.isEmpty)
        XCTAssertTrue(tasks.projectOrder.isEmpty)
        XCTAssertTrue(chat.conversations.isEmpty)
        XCTAssertTrue(chat.messages.isEmpty)
        XCTAssertNil(chat.activeID)
        XCTAssertTrue(chat.queuedSends.isEmpty)
        XCTAssertTrue(notes.tree.isEmpty)
        XCTAssertTrue(notes.pinned.isEmpty)
        XCTAssertTrue(inbox.letters.isEmpty)

        // Drafts.
        XCTAssertEqual(ComposerDrafts.shared.draft("reset-test"), "")
        XCTAssertNil(UserDefaults.standard.object(forKey: "walnut.composerDrafts"))
        XCTAssertEqual(LetterReplyStore.shared.draft(for: "l-reset-test"), "")
        XCTAssertNil(UserDefaults.standard.object(forKey: LetterReplyStore.storageKey))

        // Unsent messages and caches.
        let queue: [String]? = await DurableStore.loadAsync([String].self, key: "chat-send-queue")
        XCTAssertNil(queue)
        let cacheGone = await waitFor(3) { DiskCache.load([String].self, key: "reset-test-cache") == nil }
        XCTAssertTrue(cacheGone)
        XCTAssertFalse(fm.fileExists(atPath: attachments.path))
        XCTAssertFalse(fm.fileExists(atPath: bodies.path))
        XCTAssertFalse(fm.fileExists(atPath: futureCache.path), "a cache folder nobody listed is swept too")
        XCTAssertNil(SessionStreamResumeIDs.shared.id(for: streamKey), "stream positions are forgotten")

        // Voice and attention time.
        XCTAssertTrue(VoiceRecordingStore().pending().isEmpty)
        let freshSamples = TimeSampleStore()
        let snapshot = await freshSamples.snapshot()
        XCTAssertTrue(snapshot.isEmpty)

        // The log no longer holds a line from before the reset.
        let logText = (try? String(contentsOf: logFile, encoding: .utf8)) ?? ""
        XCTAssertFalse(logText.contains(marker), "log lines from before the reset were kept")

        // The sweep: stray file, tmp, Documents, preferences, HTTP cache.
        XCTAssertFalse(fm.fileExists(atPath: support.appendingPathComponent("reset-test-stray.bin").path))
        XCTAssertTrue(removed.contains("reset-test-stray.bin"))
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: scratch.locations.temporary.path), [])
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: scratch.locations.documents.path), [])
        XCTAssertNil(scratch.locations.defaults.object(forKey: "walnut.someFilter"))
        // URLCache finishes deleting a few milliseconds after removeAll returns.
        let httpCacheGone = await waitFor(3) { URLCache.shared.cachedResponse(for: URLRequest(url: cachedURL)) == nil }
        XCTAssertTrue(httpCacheGone, "the HTTP cache kept a response")
        // The log files themselves are emptied in place, not deleted.
        XCTAssertFalse(removed.contains("walnut-applog.jsonl"))
    }

    /// The chat's "answered on Cloud" memory (ChatStore erases it through this).
    func testCloudAnswerMarksForgetEverything() {
        let suite = "cloud-marks-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        var marks = CloudAnswerMarks(defaults: defaults)
        marks.remember(conversationID: "c1", text: "Hello", atMs: 1)
        XCTAssertFalse(marks.marks.isEmpty)
        marks.removeAll()
        XCTAssertTrue(marks.marks.isEmpty)
        XCTAssertNil(defaults.object(forKey: CloudAnswerMarks.storageKey))
        XCTAssertTrue(CloudAnswerMarks(defaults: defaults).marks.isEmpty)
    }

    func testPairingAgainStartsClean() async throws {
        // A second reset over an already clean phone is harmless and removes
        // nothing it should not.
        let scratch = try Self.scratchLocations()
        defer { try? FileManager.default.removeItem(at: scratch.root) }
        LocalDataReset.eraseAll(reason: "test", locations: scratch.locations)
        let second = LocalDataReset.eraseAll(reason: "test", locations: scratch.locations)
        XCTAssertFalse(second.contains("walnut-applog.jsonl"))
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: scratch.locations.applicationSupport.path
        ), "Application Support itself stays")
    }
}
