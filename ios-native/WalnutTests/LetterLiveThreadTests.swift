import Foundation
import XCTest
@testable import Walnut

/// An open letter shows the agent's answer in its thread without a reopen (App
/// Store gate, 2026-10-05). Nothing pushes letter changes to the app, so the
/// reader re-reads on the two signals it does get: the sender session's state
/// changing on the events feed (the agent writes its answer in that turn), and
/// the inbox list holding more of the thread than the reader shows. Never on a
/// timer.
@MainActor
final class LetterLiveThreadTests: XCTestCase {
    private var savedURL: URL?
    private var savedToken: String?
    private let api = WalnutAPI()

    private func session(_ id: String, status: String, active: String) -> WalnutSession {
        WalnutSession(
            id: id, title: "Headlines", taskId: "t-copy", taskTitle: nil, project: nil,
            host: "", processStatus: status, model: nil, mode: nil,
            startedAt: "2026-10-05T09:00:00.000Z", lastActiveAt: active,
            messageCount: 2, cwd: nil, pinned: nil, focusTier: nil, description: nil
        )
    }

    // MARK: - The rule

    func testASenderSessionChangeRereadsAndItsFirstSightingDoesNot() {
        let idle = [session("s-copy", status: "idle", active: "2026-10-05T09:01:00.000Z")]
        let running = [session("s-copy", status: "running", active: "2026-10-05T09:02:00.000Z")]
        let done = [session("s-copy", status: "idle", active: "2026-10-05T09:02:09.000Z")]
        let k0 = LetterLiveThread.sessionKey(sessionId: "s-copy", sessions: idle)
        let k1 = LetterLiveThread.sessionKey(sessionId: "s-copy", sessions: running)
        let k2 = LetterLiveThread.sessionKey(sessionId: "s-copy", sessions: done)
        XCTAssertFalse(k0.isEmpty)
        XCTAssertTrue(LetterLiveThread.sessionChangeRereads(old: k0, new: k1), "the turn started")
        XCTAssertTrue(LetterLiveThread.sessionChangeRereads(old: k1, new: k2), "the turn ended: the answer is written")
        XCTAssertFalse(LetterLiveThread.sessionChangeRereads(old: k2, new: k2))
        // The open read the letter just now: the session coming into view is not news.
        XCTAssertFalse(LetterLiveThread.sessionChangeRereads(old: "", new: k0))
        // A session the app does not hold, or a letter with no session, never re-reads.
        XCTAssertEqual(LetterLiveThread.sessionKey(sessionId: "s-other", sessions: idle), "")
        XCTAssertEqual(LetterLiveThread.sessionKey(sessionId: nil, sessions: idle), "")
        XCTAssertFalse(LetterLiveThread.sessionChangeRereads(old: k0, new: ""))
    }

    func testAFresherInboxRowRereadsAndAnOlderOneDoesNot() {
        XCTAssertTrue(LetterLiveThread.storeRowRereads(storeCount: 3, readerCount: 2))
        XCTAssertFalse(LetterLiveThread.storeRowRereads(storeCount: 2, readerCount: 2))
        // The reader adopted its own send before the list caught up.
        XCTAssertFalse(LetterLiveThread.storeRowRereads(storeCount: 1, readerCount: 2))
        XCTAssertFalse(LetterLiveThread.storeRowRereads(storeCount: nil, readerCount: 2))
        XCTAssertFalse(LetterLiveThread.storeRowRereads(storeCount: 3, readerCount: nil))
    }

    /// The reader's wiring: both signals, a re-read that does not mark the letter
    /// read again (it would undo the menu's Mark Unread), and no timer of its own.
    func testTheReaderListensToBothSignalsAndDoesNotPoll() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("Walnut/Views/Inbox/LetterReaderView.swift"), encoding: .utf8)
        XCTAssertTrue(source.contains(".onChange(of: senderSessionKey)"))
        XCTAssertTrue(source.contains(".onChange(of: inbox.letter(id: letterId)?.threadEntries.count)"))
        XCTAssertTrue(source.contains("threadReread = Task { await load(markingRead: false) }"))
        XCTAssertTrue(source.contains("reload: { await load(markingRead: false) }"), "the delivery watch's re-read marks nothing")
        XCTAssertFalse(source.contains("Timer.publish"), "the reader polls")
    }

    // MARK: - The demo says what a live agent says

    override func setUp() async throws {
        savedURL = AppConfig.processServerURLOverride
        savedToken = AppConfig.processTokenOverride
        AppConfig.processServerURLOverride = DemoMode.baseURL
        AppConfig.processTokenOverride = DemoMode.token
        DemoServer.shared.latencyScale = 0
        DemoServer.shared.turnScale = 0.05
        DemoServer.shared.reset()
    }

    override func tearDown() async throws {
        DemoServer.shared.reset()
        DemoServer.shared.latencyScale = 1
        DemoServer.shared.turnScale = 1
        AppConfig.processServerURLOverride = savedURL
        AppConfig.processTokenOverride = savedToken
    }

    private final class EventLog: @unchecked Sendable {
        private let lock = NSLock()
        private var events: [SSEEvent] = []
        func add(_ event: SSEEvent) { lock.lock(); events.append(event); lock.unlock() }
        var all: [SSEEvent] { lock.lock(); defer { lock.unlock() }; return events }
        func sessions(_ id: String) -> [WalnutSession] {
            all.filter { $0.event == "session-upsert" }
                .compactMap { try? JSONDecoder().decode(WalnutSession.self, from: Data($0.data.utf8)) }
                .filter { $0.id == id }
        }
    }

    private func waitFor(_ timeout: TimeInterval, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(30))
        }
        return condition()
    }

    private func feed() async throws -> (SSEClient, EventLog) {
        let url = try XCTUnwrap(WalnutAPI.eventsFeedURL())
        let log = EventLog()
        let client = SSEClient(url: url, token: DemoMode.token, onEvent: { log.add($0) }, onConnectionChange: { _ in })
        client.start()
        let snapshot = await waitFor(5) { log.all.contains { $0.event == "snapshot" } }
        XCTAssertTrue(snapshot)
        return (client, log)
    }

    /// A written reply: the agent's line lands, then its session is announced, so
    /// a reader that re-reads on that announcement finds the line.
    func testAWrittenReplysAnswerIsAnnouncedOnTheSendersSession() async throws {
        let (client, log) = try await feed()
        defer { client.stop() }
        let before = log.sessions("s-copy").count
        _ = try await api.replyToLetter(id: "l-headline", text: "Keep it short, please.")
        let announced = await waitFor(10) { log.sessions("s-copy").count > before }
        XCTAssertTrue(announced, "the agent's answer was written with no word on the events feed")
        let letter = try await api.letter(id: "l-headline")
        XCTAssertEqual(letter.threadEntries.last?.from, "agent", "the session was announced before the line was written")
        XCTAssertTrue(letter.threadEntries.last?.text?.contains("Thanks, got it") == true)
    }

    /// An answer: the session's turn ends after the agent's line is written.
    func testAnAnswersThreadLineIsWrittenBeforeTheTurnEndsOnTheFeed() async throws {
        let (client, log) = try await feed()
        defer { client.stop() }
        let before = log.sessions("s-copy").count
        _ = try await api.answerLetter(id: "l-headline", actionId: "b")
        // The answer's turn: running, then idle again, both on the feed.
        let ended = await waitFor(15) {
            let after = log.sessions("s-copy").dropFirst(before)
            guard let started = after.firstIndex(where: { $0.processStatus == "running" }) else { return false }
            return after[started...].contains { $0.processStatus == "idle" }
        }
        XCTAssertTrue(ended, "the answer's turn never ended on the feed")
        let letter = try await api.letter(id: "l-headline")
        XCTAssertEqual(letter.threadEntries.last?.from, "agent")
        XCTAssertTrue(letter.threadEntries.last?.text?.contains("now say") == true, letter.threadEntries.last?.text ?? "")
    }
}
