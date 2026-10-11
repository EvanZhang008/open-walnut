import Foundation
import XCTest
@testable import Walnut

/// The demo server, driven through the app's REAL clients (`WalnutAPI`,
/// `SSEClient`): every route the app calls has an answer, an unknown route is a
/// clear 404, writes show up in later reads, chat replies stream over SSE, and
/// nothing is sent to any other host.
///
/// The hosted test process is pinned to a dead address (`AppConfig`); each test
/// here points that in-memory override at the demo server and puts it back.
@MainActor
final class DemoModeTests: XCTestCase {
    private var savedURL: URL?
    private var savedToken: String?
    private let api = WalnutAPI()

    override func setUp() async throws {
        // The host app runs beside these tests: its task store's events feed, pointed
        // at the test blackhole, retries on a backoff clock, and a retry that lands
        // inside a test is a "blocked" request this suite did not make (it failed
        // `testEveryRouteTheAppCallsHasAnAnswer` twice running on 2026-10-08). The
        // host's connections stay down for the whole class (`tearDown()` below).
        LifecycleHub.shared.teardownAll()
        savedURL = AppConfig.processServerURLOverride
        savedToken = AppConfig.processTokenOverride
        AppConfig.processServerURLOverride = DemoMode.baseURL
        AppConfig.processTokenOverride = DemoMode.token
        DemoServer.shared.latencyScale = 0
        DemoServer.shared.turnScale = 0
        DemoServer.shared.reset()
        DemoURLProtocol.resetLog()
    }

    override func tearDown() async throws {
        DemoServer.shared.reset()
        DemoServer.shared.latencyScale = 1
        DemoServer.shared.turnScale = 1
        AppConfig.processServerURLOverride = savedURL
        AppConfig.processTokenOverride = savedToken
    }

    /// The host's connections come back once, after the last test here: resuming
    /// per test would start a board refresh that can land inside the next one.
    nonisolated override class func tearDown() {
        MainActor.assumeIsolated { LifecycleHub.shared.resumeAll() }
        super.tearDown()
    }

    /// Wait until every scripted step queued so far has run, and the stream hub
    /// has handed out every frame.
    private func settleTurns() {
        let deadline = Date().addingTimeInterval(5)
        while DemoServer.shared.pendingStepCount > 0, Date() < deadline {
            usleep(5_000)
        }
        DemoServer.shared.turnQueue.sync {}
        DemoServer.shared.streams.drain()
        XCTAssertEqual(DemoServer.shared.pendingStepCount, 0, "scripted turns did not finish")
    }

    // MARK: - Every route the app calls

    func testEveryRouteTheAppCallsHasAnAnswer() async throws {
        // Status, devices, agents, config.
        _ = try await api.status()
        _ = try await api.testStatus(serverURL: DemoMode.baseURLString, token: DemoMode.token)
        try await api.reportDeviceInfo(model: "iPhone", os: "iOS 18", deviceName: "Demo", appVersion: "1.0")
        let agents = try await api.agents()
        XCTAssertFalse(agents.isEmpty)
        _ = try await api.serverConfig()

        // Chat.
        let conversations = try await api.conversations()
        XCTAssertFalse(conversations.isEmpty, "the demo has sample conversations")
        let sample = try XCTUnwrap(conversations.first { $0.id == DemoEntry.sampleConversationID })
        let sampleMessages = try await api.messages(conversationID: sample.id)
        XCTAssertFalse(sampleMessages.isEmpty)
        let newID = try await api.createConversation(title: "Route check")
        _ = try await api.sendMessage(conversationID: newID, text: "What should I focus on today?")
        settleTurns()
        _ = try await api.patchConversation(id: newID, title: "Renamed", pinned: true)
        _ = try await api.stopConversation(id: newID)
        try await api.answerConversationQuestion(id: newID, answers: ["q": "a"])
        _ = try await api.chatStats()
        _ = try await api.chatEngine()
        _ = try await api.chatEngineSession()
        _ = try await api.setChatModel(model: "claude-sonnet-5-5")
        _ = try await api.asks()
        try await api.deleteConversation(id: newID)

        // Tasks.
        let tasks = try await api.tasks()
        XCTAssertGreaterThan(tasks.tasks.count, 10)
        let created = try await api.createTask(title: "Route check task", project: "Home", pin: .unspecified)
        let landed = try await api.focusTasks()
        XCTAssertTrue(landed.satelliteTasks?.contains(created.id) ?? false,
                      "as on a real server, a new task with no pin choice lands in Satellite")
        _ = try await api.updateTask(id: created.id, priority: "important")
        _ = try await api.backfillTask(id: created.id, title: "Route check task, renamed")
        _ = try await api.taskDetail(id: "t-crash")
        _ = try await api.toggleTaskStar(id: created.id)
        try await api.setTaskField(id: created.id, field: "description", content: "Notes")
        _ = try await api.focusTasks()
        _ = try await api.focusTiers()
        _ = try await api.taskFolders()
        _ = try await api.pinTask(id: created.id)
        _ = try await api.setTaskFocusTier(id: created.id, tier: "backlog")
        _ = try await api.unpinTask(id: created.id)
        _ = try await api.quickParseTask(text: "Call the plumber tomorrow")
        _ = try await api.batchSetPhase(taskIds: [created.id], phase: "IN_PROGRESS")
        _ = try await api.globalSearch(query: "crash")
        try await api.deleteTask(id: created.id)
        let spare = try await api.createTask(title: "Batch delete me")
        _ = try await api.batchDeleteTasks(taskIds: [spare.id])

        // Sessions.
        let sessions = try await api.sessions()
        XCTAssertGreaterThanOrEqual(sessions.sessions.count, 5)
        _ = try await api.sessionDetail(id: "s-crash")
        _ = try await api.sessionTranscript(id: "s-crash")
        _ = try await api.sessionTranscript(id: "s-crash", fresh: true, rich: true)
        // The session page reads its transcript in pages (Load earlier).
        let page = try await api.sessionTranscriptPage(id: "s-crash", before: nil, since: nil, visible: 20)
        let oldest = try XCTUnwrap(page.messages.first?.timestamp)
        _ = try await api.sessionTranscriptPage(id: "s-crash", before: oldest, since: nil, visible: 50)
        _ = try await api.sessionTranscriptPage(id: "s-crash", before: nil, since: page.messages.last?.timestamp, visible: 0)
        _ = try await api.sessionModelOptions(id: "s-crash")
        _ = try await api.setSessionModel(id: "s-crash", model: "claude-sonnet-5-5")
        _ = try await api.setSessionEffort(id: "s-crash", effort: "high")
        _ = try await api.sessionControls(id: "s-crash")
        _ = try await api.applySessionControl(id: "s-crash", controlId: "mode", value: "plan")
        _ = try await api.sessionQueue(id: "s-crash")
        _ = try await api.sessionSideQuestions(id: "s-crash")
        _ = try await api.askSideQuestion(sessionId: "s-crash", question: "Is this safe?")
        _ = try await api.sessionLaunchOptions()
        _ = try await api.listDirs(prefix: "/Users/demo/code/")
        _ = try await api.listFiles(path: "/Users/demo/code/pebble")
        _ = try await api.fileContent(path: "/Users/demo/code/pebble/README.md")
        _ = try await api.resolvePath(rel: "Sources/App.swift", cwd: "/Users/demo/code/pebble")
        _ = try await api.patchSession(id: "s-crash", title: "Shared album crash")
        _ = try await api.sendSessionMessage(id: "s-crash", text: "Run the tests again", messageId: "qm-route-check-1")
        settleTurns()
        let launched = try await api.createSession(cwd: "/Users/demo/code/pebble", message: "Look at the README")
        _ = try await api.forkSession(id: "s-crash", message: nil)
        _ = try await api.terminateSession(id: launched.sessionId)
        _ = try await api.restartSession(id: launched.sessionId)
        _ = try await api.retrySession(id: launched.sessionId)
        try await api.deleteQueuedMessage(sessionId: "s-crash", messageId: "q-none")
        try await api.editQueuedMessage(sessionId: "s-crash", messageId: "q-none", text: "edited")
        do {
            _ = try await api.sessionPlan(id: "s-crash")
            XCTFail("a session without a plan answers 404, which the plan sheet shows as empty")
        } catch let error as APIError {
            XCTAssertEqual(error.code, "not_found")
        }
        _ = try await api.respondSessionPermission(id: "s-uptime", requestId: "perm-uptime-restart", allow: true)
        settleTurns()

        // Notes.
        let tree = try await api.notesTree()
        XCTAssertFalse(tree.isEmpty)
        let note = try await api.noteContent(path: "Pebble/Release 2.4 plan.md")
        _ = try await api.saveNote(path: "Pebble/Release 2.4 plan.md", content: note.content + "\nMore.", expectedHash: note.contentHash)
        _ = try await api.createNote(path: "Inbox/Route check", content: "Hello")
        try await api.deleteNote(path: "Inbox/Route check.md")
        _ = try await api.searchNotes(query: "kitchen")
        _ = try await api.favoriteNotes()
        _ = try await api.addFavoriteNote(path: "Travel/Coast trip.md")
        _ = try await api.removeFavoriteNote(path: "Travel/Coast trip.md")
        _ = try await api.uploadAttachment(notePath: "Inbox.md", data: DemoImage.png, mediaType: "image/png")

        // Inbox.
        let letters = try await api.letters()
        XCTAssertFalse(letters.letters.isEmpty)
        _ = try await api.letters(archived: true)
        _ = try await api.letter(id: "l-pricing")
        _ = try await api.setLetterRead(id: "l-pricing", read: true)
        _ = try await api.setLetterPinned(id: "l-pricing", pinned: true)
        _ = try await api.setLetterArchived(id: "l-weekly", archived: true)
        _ = try await api.answerLetter(id: "l-headline", actionId: "a")
        _ = try await api.replyToLetter(id: "l-pricing", text: "Looks great")
        _ = try await api.replyToLetter(id: "l-pricing", text: "One more thing", clientId: "client-1")

        // Routines.
        let routines = try await api.routines()
        XCTAssertFalse(routines.isEmpty)
        _ = try await api.toggleRoutine(id: "r-plants")
        try await api.runRoutineNow(id: "r-briefing")
        try await api.deleteRoutine(id: "r-weekly")

        // Voice, push and the background reporters.
        let heard = try await api.transcribe(audio: Data(repeating: 0, count: 64), format: "m4a")
        XCTAssertEqual(heard, DemoFixtures.transcriptionSentence(DemoServer.shared.clockNow))
        _ = try await api.transcribeVoice(audio: Data(repeating: 0, count: 64), format: "m4a")
        let push = try await api.pushStatus()
        XCTAssertEqual(push.apns?.configured, false, "the demo can never send a notification")
        try await api.registerPushToken(token: "00", environment: "sandbox", mode: "always")
        try await api.setPushPreferences(mode: "always")
        try await api.reportPushActive(true)
        for path in ["/api/v1/client-logs", "/api/v1/time/heartbeats"] {
            var request = URLRequest(url: DemoMode.baseURL.appendingPathComponent(path))
            request.httpMethod = "POST"
            request.httpBody = Data("{}".utf8)
            let (_, response) = try await URLSession.shared.data(for: request)
            XCTAssertTrue((200...299).contains((response as? HTTPURLResponse)?.statusCode ?? 0), path)
        }

        // Images (media, note attachments) are real PNG bytes.
        for url in [
            WalnutAPI.mediaURL(absolutePath: "/tmp/shot.png"),
            WalnutAPI.attachmentURL(rawPath: "photo.png", notePath: "Inbox.md"),
        ] {
            let (data, response) = try await URLSession.shared.data(from: try XCTUnwrap(url))
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            XCTAssertNotNil(UIImage(data: data))
        }

        // Connection routes: the demo has one address, so nothing to learn, and
        // the identity probe (its own URLSession) is answered in-process too.
        let order = try await api.projectOrder()
        XCTAssertEqual(order, DemoFixtures.projectOrder)
        let routes = try await api.routes()
        XCTAssertEqual(routes.routes, [], "no other route for the selector to try")
        let probe = await InstanceProbe.probe(.custom(DemoMode.baseURLString))
        guard case .ok = probe else { return XCTFail("the identity probe got \(probe)") }

        XCTAssertEqual(DemoServer.shared.unansweredRoutes, [], "every route above has a demo answer")
        XCTAssertEqual(DemoURLProtocol.blockedByTheCodeUnderTest, [], "nothing went to any other host")
    }

    /// Load earlier reads a session's transcript in pages. The demo's
    /// conversations are short and its answer never says it pages, so the
    /// session page gets the whole conversation in its first read and shows no
    /// Load earlier row; an older page asked anyway is the same whole answer.
    func testTheDemoSessionPageReadsOneWholePageAndOffersNoLoadEarlier() async throws {
        let whole = try await api.sessionTranscript(id: "s-crash", fresh: true, rich: true)
        let first = try await api.sessionTranscriptPage(id: "s-crash", before: nil, since: nil, visible: 20)
        XCTAssertEqual(first.messages.map(\.timestamp), whole.messages.map(\.timestamp),
                       "the first page is the whole demo conversation")
        XCTAssertNil(first.pageable, "the demo never offers older pages")
        XCTAssertFalse(first.truncated)
        let oldest = try XCTUnwrap(first.messages.first?.timestamp)
        let older = try await api.sessionTranscriptPage(id: "s-crash", before: oldest, since: nil, visible: 50)
        XCTAssertNil(older.pageable)

        let listed = try await api.sessions().sessions
        let session = try XCTUnwrap(listed.first { $0.id == "s-crash" })
        let store = SessionConversationStore(session: session, resumeIDs: SessionStreamResumeIDs(defaults: nil))
        await store.open()
        XCTAssertFalse(store.messages.isEmpty, "the page shows the demo conversation")
        XCTAssertFalse(store.canPage)
        XCTAssertFalse(store.showsLoadEarlier, "no Load earlier row in the demo")
        store.close()
        XCTAssertEqual(DemoServer.shared.unansweredRoutes, [])
        XCTAssertEqual(DemoURLProtocol.blockedByTheCodeUnderTest, [], "nothing went to any other host")
    }

    func testUnknownRouteIsAClearNotFoundNotAHang() async throws {
        let started = Date()
        do {
            struct Anything: Decodable {}
            let _: Anything = try await api.get("/no-such-route")
            XCTFail("an unknown route must fail")
        } catch let APIError.server(status, code, message, _, _) {
            XCTAssertEqual(status, 404)
            XCTAssertEqual(code, "not_found")
            XCTAssertTrue(message.contains("/api/v1/no-such-route"), message)
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 2, "a 404, not a timeout")
        XCTAssertEqual(DemoServer.shared.unansweredRoutes, ["GET /api/v1/no-such-route"])
    }

    // MARK: - Writes update reads

    func testWritesShowUpInLaterReads() async throws {
        // Create, then complete, a task.
        let created = try await api.createTask(title: "Buy light bulbs", project: "Home", pin: .tier("focus"))
        var tasks = try await api.tasks().tasks
        XCTAssertEqual(tasks.first { $0.id == created.id }?.title, "Buy light bulbs")
        let split = try await api.focusTasks()
        XCTAssertTrue(split.focusTasks?.contains(created.id) ?? false)
        _ = try await api.updateTask(id: created.id, status: "done")
        tasks = try await api.tasks().tasks
        XCTAssertEqual(tasks.first { $0.id == created.id }?.phase, "COMPLETE")
        XCTAssertNotNil(tasks.first { $0.id == created.id }?.completedAt)

        // Answer a letter, reply to another.
        _ = try await api.answerLetter(id: "l-headline", actionId: "b")
        let headline = try await api.letter(id: "l-headline")
        XCTAssertEqual(headline.answered?.actionId, "b")
        // The answer reaches the copy session as its next turn; once that turn
        // is done, so is the task it was about.
        settleTurns()
        let afterAnswer = try await api.tasks().tasks
        XCTAssertEqual(afterAnswer.first { $0.id == "t-copy" }?.phase, "COMPLETE",
                       "the decision moves the task it was about")
        _ = try await api.replyToLetter(id: "l-pricing", text: "Ship it")
        settleTurns()
        let pricing = try await api.letter(id: "l-pricing")
        let thread = pricing.thread ?? []
        XCTAssertTrue(thread.contains { $0.isHuman && $0.text == "Ship it" }, "the reply is in the thread")
        XCTAssertEqual(thread.last?.from, "agent", "and the agent writes back")

        // A note save, then a stale save is a real conflict.
        let path = "Home/Meal ideas.md"
        let before = try await api.noteContent(path: path)
        let saved = try await api.saveNote(path: path, content: "Soup on Sunday", expectedHash: before.contentHash)
        let reread = try await api.noteContent(path: path)
        XCTAssertEqual(reread.content, "Soup on Sunday")
        XCTAssertNotEqual(saved.contentHash, before.contentHash)
        do {
            _ = try await api.saveNote(path: path, content: "Lost edit", expectedHash: before.contentHash)
            XCTFail("a save quoting an old hash must conflict")
        } catch let APIError.server(status, code, _, serverHash, serverContent) {
            XCTAssertEqual(status, 409)
            XCTAssertEqual(code, "conflict")
            XCTAssertEqual(serverHash, saved.contentHash)
            XCTAssertEqual(serverContent, "Soup on Sunday")
        }

        // A message into a session lands in its transcript.
        let before2 = try await api.sessionTranscript(id: "s-offline").messages.count
        _ = try await api.sendSessionMessage(id: "s-offline", text: "Run the tests")
        settleTurns()
        let after = try await api.sessionTranscript(id: "s-offline").messages
        XCTAssertGreaterThan(after.count, before2)
        XCTAssertEqual(after.first { $0.role == "user" && $0.text == "Run the tests" }?.text, "Run the tests")
        let sessionsAfter = try await api.sessions().sessions
        XCTAssertEqual(sessionsAfter.first { $0.id == "s-offline" }?.processStatus, "idle")

        // Allow on the waiting permission clears it and finishes the turn.
        let waiting = try await api.sessionDetail(id: "s-uptime")
        XCTAssertEqual(waiting.pendingPermissions.count, 1)
        _ = try await api.respondSessionPermission(id: "s-uptime", requestId: "perm-uptime-restart", allow: true)
        settleTurns()
        let resolved = try await api.sessionDetail(id: "s-uptime")
        XCTAssertEqual(resolved.pendingPermissions.count, 0)
        let uptimeRows = try await api.sessionTranscript(id: "s-uptime").messages
        XCTAssertTrue(uptimeRows.contains { $0.text.contains("alert agent restarted") })
    }

    // MARK: - Streams

    private final class EventLog: @unchecked Sendable {
        private let lock = NSLock()
        private var events: [SSEEvent] = []
        func add(_ event: SSEEvent) { lock.lock(); events.append(event); lock.unlock() }
        var all: [SSEEvent] { lock.lock(); defer { lock.unlock() }; return events }
        func names() -> [String] { all.map(\.event) }
    }

    private func waitFor(_ timeout: TimeInterval, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(30))
        }
        return condition()
    }

    func testChatReplyStreamsOverTheRealSSEClient() async throws {
        DemoServer.shared.turnScale = 0.05
        let id = DemoEntry.sampleConversationID
        let url = try XCTUnwrap(URL(string: "\(DemoMode.baseURLString)/api/v1/conversations/\(id)/stream?agentId=general"))
        let log = EventLog()
        let client = SSEClient(url: url, token: DemoMode.token, onEvent: { log.add($0) }, onConnectionChange: { _ in })
        client.start()
        defer { client.stop() }
        // At least ours: the host app's own chat store may attach too, since the
        // whole process now points at the demo.
        let attached = await waitFor(5) { DemoServer.shared.streams.subscriberCount(.conversation(id)) >= 1 }
        XCTAssertTrue(attached, "the stream attached")

        let turnID = try await api.sendMessage(conversationID: id, text: "How are the kitchen quotes going?")
        let ended = await waitFor(10) { log.names().contains("message-end") }
        XCTAssertTrue(ended, "the reply ended; got \(log.names())")
        let names = log.names()
        XCTAssertEqual(names.first, "message-start")
        XCTAssertTrue(names.contains("thinking"))
        XCTAssertGreaterThan(names.filter { $0 == "text-delta" }.count, 3, "the reply arrives in pieces")
        let streamed = log.all.filter { $0.event == "text-delta" }.compactMap { event -> String? in
            (try? JSONSerialization.jsonObject(with: Data(event.data.utf8)) as? [String: String])?["delta"]
        }.joined()
        XCTAssertTrue(streamed.contains("counter quotes"), streamed)
        let end = try XCTUnwrap(log.all.last { $0.event == "message-end" })
        XCTAssertTrue(end.data.contains(turnID))

        let history = try await api.messages(conversationID: id)
        XCTAssertEqual(history.last?.role, "assistant")
        XCTAssertTrue(history.last?.text.contains("counter quotes") ?? false)
        XCTAssertTrue(history.contains { $0.role == "user" && $0.text == "How are the kitchen quotes going?" })
    }

    func testEventsFeedSendsASnapshotThenUpserts() async throws {
        let url = try XCTUnwrap(WalnutAPI.eventsFeedURL())
        let log = EventLog()
        let client = SSEClient(url: url, token: DemoMode.token, onEvent: { log.add($0) }, onConnectionChange: { _ in })
        client.start()
        defer { client.stop() }
        let snapshot = await waitFor(5) { log.names().contains("snapshot") }
        XCTAssertTrue(snapshot)
        _ = try await api.createTask(title: "Water the ferns")
        let upserted = await waitFor(5) { log.all.contains { $0.event == "task-upsert" && $0.data.contains("Water the ferns") } }
        XCTAssertTrue(upserted, "got \(log.names())")
    }

    // MARK: - Search and the completed-task window

    /// Ids of the four crash fixes finished weeks ago (`DemoFixtures.tasks`).
    private static let oldCrashFixes: Set<String> = ["t-upload-crash", "t-delete-crash", "t-restore-crash", "t-widget-crash"]

    /// The task list and the events feed carry open tasks and 14 days of completed
    /// ones, as the real server's projection does; older completed tasks are left on
    /// the server. Search still finds them and names them in its answer, the Tasks
    /// tab arranges them as three inline hits and "Completed (1)", and each opens.
    func testOldCompletedTasksAreFoundBySearchNotListed() async throws {
        let listed = try await api.tasks().tasks
        let listedIds = Set(listed.map(\.id))
        XCTAssertTrue(listedIds.isDisjoint(with: Self.oldCrashFixes), "the list carries a task finished weeks ago")
        for recent in ["t-cache", "t-links", "t-library"] {
            XCTAssertTrue(listedIds.contains(recent), "\(recent) was finished this week and belongs in the list")
        }
        XCTAssertEqual(listed.count, DemoFixtures.seed().tasks.count - Self.oldCrashFixes.count)

        // The feed's snapshot is the same list.
        let url = try XCTUnwrap(WalnutAPI.eventsFeedURL())
        let log = EventLog()
        let client = SSEClient(url: url, token: DemoMode.token, onEvent: { log.add($0) }, onConnectionChange: { _ in })
        client.start()
        defer { client.stop() }
        let gotSnapshot = await waitFor(5) { log.names().contains("snapshot") }
        XCTAssertTrue(gotSnapshot)
        let snapshot = try XCTUnwrap(log.all.first { $0.event == "snapshot" })
        XCTAssertTrue(snapshot.data.contains("\"t-cache\""))
        for id in Self.oldCrashFixes {
            XCTAssertFalse(snapshot.data.contains("\"\(id)\""), "the feed's snapshot carries \(id)")
        }

        // Search answers them, with the tasks they name.
        let answer = try await api.globalSearch(query: "crash")
        let named = Set((answer.tasks ?? []).map(\.id))
        XCTAssertTrue(Self.oldCrashFixes.isSubset(of: named), "the answer does not name the old crash fixes: \(named)")
        XCTAssertTrue((answer.tasks ?? []).filter { Self.oldCrashFixes.contains($0.id) }.allSatisfy(\.isDone))

        // The Tasks tab's arrangement. The open crash task is on the board above, so
        // the section holds the old fixes, the three most recently finished inline and
        // the fourth behind "Completed (1)", then the two open tasks whose summaries
        // name the crash fix.
        let onBoard = Set(listed.filter { !$0.isDone && SearchRelevance.taskMatchesLiterally($0, lowerQuery: "crash") }.map(\.id))
        XCTAssertEqual(onBoard, ["t-crash"])
        let arrangement = SearchArrangement.arrange(
            query: "crash", serverRows: answer.results, responseTasks: answer.tasks ?? [],
            storeTasks: listed, localDone: listed.filter(\.isDone),
            visibleTaskIds: onBoard, nothingAbove: false
        )
        let inline = Array(arrangement.primary.prefix(SearchArrangement.inlineCompletedHits))
        XCTAssertEqual(inline.map(\.id), ["t-upload-crash", "t-delete-crash", "t-restore-crash"])
        XCTAssertTrue(inline.allSatisfy { !$0.isOpen && $0.task != nil }, "an inline completed hit has no task row")
        let openHits = arrangement.primary.dropFirst(SearchArrangement.inlineCompletedHits)
        XCTAssertEqual(Set(openHits.map(\.id)), ["t-notes", "t-testflight"])
        XCTAssertTrue(openHits.allSatisfy(\.isOpen))
        XCTAssertEqual(arrangement.completed.map(\.id), ["t-widget-crash"], "no Completed (1) fold for crash")
        XCTAssertTrue(arrangement.related.isEmpty)

        // Each opens: the detail route answers a task the list does not carry.
        for id in Self.oldCrashFixes {
            let detail = try await api.taskDetail(id: id)
            XCTAssertEqual(detail.phase, "COMPLETE")
        }
        XCTAssertEqual(DemoServer.shared.unansweredRoutes, [])
        XCTAssertEqual(DemoURLProtocol.blockedByTheCodeUnderTest, [], "nothing went to any other host")
    }

    /// Search reads an id that starts another (6 characters or more) as the same task,
    /// the server's short id for the board's full one (`BoardSearchHitDedup`), and drops
    /// it under the board row. No two demo tasks may read that way: "t-crash-upload"
    /// vanished under the open "t-crash" in the first run of the test above.
    func testNoDemoTaskIdStartsAnother() {
        let ids = DemoFixtures.seed().tasks.map(\.id)
        for a in ids {
            for b in ids where a != b {
                XCTAssertFalse(BoardSearchHitDedup.sameTask(a, b), "\(a) and \(b) read as one task in search")
            }
        }
    }

    /// The window is the server's: completed 13 days ago is listed, 15 days ago is not,
    /// and an open task is listed however old.
    func testTheListKeepsFourteenDaysOfCompletedTasks() {
        let now = Date()
        func task(_ id: String, phase: String, doneDaysAgo: Double?) -> DemoTask {
            let at = DemoClock.iso(now.addingTimeInterval(-(doneDaysAgo ?? 60) * 86_400))
            return DemoTask(
                id: id, title: id, phase: phase, priority: "none", project: "", createdAt: at, updatedAt: at,
                completedAt: doneDaysAgo == nil ? nil : at, pinned: false
            )
        }
        var state = DemoState()
        state.tasks = [
            task("open-old", phase: "TODO", doneDaysAgo: nil),
            task("done-13", phase: "COMPLETE", doneDaysAgo: 13),
            task("done-15", phase: "COMPLETE", doneDaysAgo: 15),
        ]
        XCTAssertEqual(state.listedTasks(now: now).map(\.id), ["open-old", "done-13"])
    }

    // MARK: - Recently opened

    /// The drawer's sample history names things the demo has, newest first, and each
    /// row goes somewhere: the two conversations to their session, the two task pages
    /// to their task (the cache upgrade reads Done).
    func testTheSampleHistoryOpensWhatTheDemoHas() throws {
        let state = DemoFixtures.seed()
        let clock = DemoClock()
        let entries = DemoFixtures.recentOpens(state, clock)
        XCTAssertEqual(entries.map(\.id), ["t-crash", "t-copy", "t-quotes", "t-cache"])
        XCTAssertEqual(entries.map(\.openedAt), entries.map(\.openedAt).sorted(by: >), "newest first")
        let rows = RecentRow.rows(
            entries, tasks: state.listedTasks(now: clock.now).map(\.wire),
            sessions: state.visibleSessions.map { state.wireSession($0) }, now: clock.now
        )
        XCTAssertEqual(rows.count, 4)
        guard case .session(let crash) = rows[0].primary else { return XCTFail("the crash row does not open its session") }
        XCTAssertEqual(crash.id, "s-crash")
        guard case .session(let copy) = rows[1].primary else { return XCTFail("the headline row does not open its session") }
        XCTAssertEqual(copy.id, "s-copy")
        guard case .task(let quotes) = rows[2].primary else { return XCTFail("the quotes row does not open its task") }
        XCTAssertEqual(quotes.id, "t-quotes")
        XCTAssertEqual(rows[1].title, "Review the onboarding copy changes", "a row reads as its task")
        XCTAssertTrue(rows[3].isDone)
        XCTAssertTrue(rows[3].meta.hasSuffix("Done"), rows[3].meta)
        XCTAssertFalse(rows.contains { $0.title == "Untitled" })
    }

    func testSessionStreamShowsTheWaitingPermissionOnAttach() async throws {
        let url = try XCTUnwrap(WalnutAPI.sessionStreamURL(id: "s-uptime"))
        let log = EventLog()
        let client = SSEClient(url: url, token: DemoMode.token, onEvent: { log.add($0) }, onConnectionChange: { _ in })
        client.start()
        defer { client.stop() }
        let gotSnapshot = await waitFor(5) { log.names().contains("snapshot") }
        XCTAssertTrue(gotSnapshot)
        let snapshot = try XCTUnwrap(log.all.first { $0.event == "snapshot" })
        XCTAssertTrue(snapshot.data.contains("\"isStreaming\":true"))
        XCTAssertTrue(snapshot.data.contains("tool_call"))
    }

    // MARK: - Nothing leaves the phone

    func testWhileInTheDemoEveryOtherHostIsRefusedLocally() async throws {
        XCTAssertTrue(DemoMode.isActive)
        let other = try XCTUnwrap(URL(string: "https://example.com/anything"))
        for session in [URLSession.shared, URLSession(configuration: DemoMode.configured(.default))] {
            do {
                _ = try await session.data(from: other)
                XCTFail("a request to another host must not go out in the demo")
            } catch {
                XCTAssertEqual((error as? URLError)?.code, .notConnectedToInternet)
            }
        }
        XCTAssertEqual(DemoURLProtocol.blockedByTheCodeUnderTest.map(\.host), ["example.com", "example.com"])
        DemoURLProtocol.resetLog()
    }

    func testOutsideTheDemoRealServersAreNotTouched() {
        AppConfig.processServerURLOverride = URL(string: "https://walnut.example.net")
        defer { AppConfig.processServerURLOverride = DemoMode.baseURL }
        XCTAssertFalse(DemoMode.isActive)
        let real = URLRequest(url: URL(string: "https://walnut.example.net/api/v1/status")!)
        XCTAssertFalse(DemoURLProtocol.canInit(with: real), "a paired app's own traffic is never claimed")
        let demo = URLRequest(url: DemoMode.baseURL.appendingPathComponent("api/v1/status"))
        XCTAssertTrue(DemoURLProtocol.canInit(with: demo), "the demo address never reaches a network")
    }

    func testEveryAppSessionCarriesTheDemoProtocol() {
        let config = DemoMode.configured(.default)
        XCTAssertTrue(config.protocolClasses?.first == DemoURLProtocol.self)
        // Installing twice does not stack it.
        DemoMode.install(on: config)
        XCTAssertEqual(config.protocolClasses?.filter { $0 == DemoURLProtocol.self }.count, 1)
    }

    /// A URLSession built from its own configuration does not see globally
    /// registered protocols, so one that skips `DemoMode.configured` would send
    /// the demo's traffic to a real network. Every one in the app must go through it.
    func testNoSessionInTheAppBypassesTheDemo() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut")
        let files = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
        var offenders: [String] = []
        var checked = 0
        for case let url as URL in files where url.pathExtension == "swift" {
            let text = try String(contentsOf: url, encoding: .utf8)
            for line in text.components(separatedBy: "\n") where line.contains("URLSession(configuration:") {
                checked += 1
                if !line.contains("DemoMode.configured(") {
                    offenders.append("\(url.lastPathComponent): \(line.trimmingCharacters(in: .whitespaces))")
                }
            }
        }
        XCTAssertGreaterThan(checked, 3, "the scan found the app's sessions")
        XCTAssertEqual(offenders, [], "wrap the configuration in DemoMode.configured(...)")
    }

    // MARK: - Leaving clears the demo

    func testLeavingTheDemoForgetsEverythingWrittenInIt() async throws {
        let scratch = try LocalDataResetTests.scratchLocations()
        LocalDataReset.locationsOverrideForTesting = scratch.locations
        let saved = LocalDataReset.registrationForTesting
        // Connect and disconnect write the container's real pairing; put back
        // whatever this simulator was paired to.
        let pairedURL = UserDefaults.standard.string(forKey: "walnut.serverUrl")
        let pairedName = UserDefaults.standard.string(forKey: "walnut.deviceName")
        let pairedToken = KeychainHelper.get("walnut.deviceToken")
        defer {
            LocalDataReset.locationsOverrideForTesting = nil
            LocalDataReset.registrationForTesting = saved
            try? FileManager.default.removeItem(at: scratch.root)
            if let pairedURL { UserDefaults.standard.set(pairedURL, forKey: "walnut.serverUrl") }
            if let pairedName { UserDefaults.standard.set(pairedName, forKey: "walnut.deviceName") }
            if let pairedToken { KeychainHelper.set(pairedToken, forKey: "walnut.deviceToken") }
            AppConfig.resetTokenCacheForTesting()
        }
        let connection = ConnectionStore()
        let tasks = TasksStore()
        let chat = ChatStore()
        let notes = NotesStore()
        let inbox = InboxStore()
        LocalDataReset.register(tasks: tasks, chat: chat, notes: notes, inbox: inbox, filePreview: nil)

        try await DemoEntry.enter(connection: connection, recents: tasks.recents)
        XCTAssertTrue(connection.isConfigured)
        XCTAssertTrue(DemoMode.isActive)
        // The Tasks drawer starts from the demo's sample history.
        XCTAssertEqual(tasks.recents.entries.map(\.id), ["t-crash", "t-copy", "t-quotes", "t-cache"])
        let created = try await api.createTask(title: "Only in this demo run")
        tasks.tasks = try await api.tasks().tasks
        XCTAssertTrue(tasks.tasks.contains { $0.id == created.id })

        connection.disconnect()

        XCTAssertFalse(connection.isConfigured)
        XCTAssertTrue(tasks.tasks.isEmpty, "the board forgets the demo")
        XCTAssertTrue(tasks.recents.entries.isEmpty, "the drawer forgets the demo")
        // This class pins the process at the demo's address; outside it, nothing.
        let pinned = AppConfig.processServerURLOverride
        AppConfig.processServerURLOverride = URL(string: "http://127.0.0.1:9")
        XCTAssertFalse(DemoMode.isActive)
        XCTAssertEqual(DemoEntry.sampleRecentOpens().count, 0, "outside the demo there is no sample history")
        AppConfig.processServerURLOverride = pinned
        XCTAssertEqual(DemoServer.shared.streams.subscriberCount(.events), 0)
        let after = try await api.tasks().tasks
        XCTAssertFalse(after.contains { $0.id == created.id }, "the demo server is back to its fixtures")
        XCTAssertEqual(after.count, DemoFixtures.seed().listedTasks(now: Date()).count)
    }

    // MARK: - Fixture hygiene

    func testFixtureTextHasNoDashesOrRemoteLinks() async throws {
        var texts: [String] = []
        let state = DemoFixtures.seed()
        texts += state.tasks.flatMap { [$0.title, $0.summary ?? "", $0.description ?? "", $0.project] }
        texts += state.sessions.flatMap { [$0.title, $0.description ?? ""] + $0.transcript.map(\.text) }
        texts += state.conversations.flatMap { $0.messages.map(\.text) + [$0.title ?? ""] }
        texts += state.letters.flatMap { [$0.subject, $0.textPreview ?? "", $0.body ?? ""] }
        texts += state.notes.map(\.content)
        for text in texts {
            XCTAssertFalse(text.contains("\u{2014}") || text.contains("\u{2013}"), "dash in fixture text: \(text.prefix(80))")
            XCTAssertFalse(text.contains("http://") || text.contains("https://"), "remote link in fixture text: \(text.prefix(80))")
        }
    }

    /// The demo's models are the server catalog's current ones, id and label
    /// exactly as `src/model/providers/model-catalog.ts` lists them, and the
    /// default is the catalog's first Anthropic model. A newer model replaces
    /// the older one of its family, so a stale demo model fails here.
    func testDemoModelsAreTheCatalogsCurrentOnes() throws {
        let catalog = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("src/model/providers/model-catalog.ts")
        let source = try String(contentsOf: catalog, encoding: .utf8)
        let anthropic = try XCTUnwrap(source.components(separatedBy: "anthropic: [").dropFirst().first?
            .components(separatedBy: "],").first, "no Anthropic section in the catalog")
        // (id, label) pairs in catalog order.
        let pattern = try NSRegularExpression(pattern: #"id: '([^']+)',[^}]*?label: '([^']+)'"#,
                                              options: [.dotMatchesLineSeparators])
        let range = NSRange(anthropic.startIndex..., in: anthropic)
        let rows = pattern.matches(in: anthropic, range: range).map { match in
            (String(anthropic[Range(match.range(at: 1), in: anthropic)!]),
             String(anthropic[Range(match.range(at: 2), in: anthropic)!]))
        }
        XCTAssertFalse(rows.isEmpty, "could not read the catalog")
        XCTAssertEqual(rows.first?.0, DemoFixtures.mainModel, "the default is the catalog's first model")
        for model in DemoFixtures.models {
            XCTAssertTrue(rows.contains { $0 == (model.id, model.label) },
                          "\(model.id) / \(model.label) is not in the catalog as written")
            // The first catalog row of the model's family is its newest member.
            let family = model.label.split(separator: " ").first.map(String.init) ?? ""
            XCTAssertEqual(rows.first { $0.1.hasPrefix(family + " ") }?.0, model.id,
                           "\(model.label) is not the newest \(family)")
        }
    }
}
