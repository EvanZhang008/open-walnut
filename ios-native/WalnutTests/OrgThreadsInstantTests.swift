import Observation
import XCTest
@testable import Walnut

/// A hand's change shows at once, everywhere it is counted (2026-11-19, the user: a thread he
/// acted on kept the red dot outside for about twenty seconds; "it should be instant").
///
///  1. A thread action moves the card AND the node's count (its task row's `user_status.threads`,
///     which the Org list's badge, the Threads switch and the chat's bar read) before the write
///     is answered; a refusal puts both back and says so; a read or a feed event that lands while
///     the write is out never flips them back.
///  2. Every surface of a node reads one store (`OrgThreadsStore.forNode`).
///  3. A task's status set by hand reads its new state at once (a reopened task stops reading
///     Done), held while its write is out, undone on a refusal.
///  4. Changes made elsewhere come in live: the feed's `threads-changed` / `inbox-changed` frames
///     and a status that moved (older servers) read the threads, the org and the inbox again,
///     coalesced.
@MainActor
final class OrgThreadsInstantTests: XCTestCase {
    private static let node = "task-instant-vp"

    // MARK: - Fixtures

    private func thread(_ id: String, state: String = "needs", shown: Bool? = true,
                        updatedAt: String = "2026-11-19T10:00:00.000Z") -> OrgThread {
        OrgThread(id: id, title: "Thread \(id)", state: state, messages: [],
                  createdAt: "2026-11-19T09:00:00.000Z", updatedAt: updatedAt, shown: shown)
    }

    private func nodeTask(threads: WalnutThreadCounts?, status: String = "needs") -> WalnutTask {
        var t = WalnutTask(
            id: Self.node, title: "Growth lead", status: "in_progress", phase: "IN_PROGRESS",
            priority: "none", project: "growth", dueDate: nil,
            createdAt: "2026-11-19T09:00:00Z", updatedAt: "2026-11-19T09:00:00Z",
            completedAt: nil, starred: nil, pinned: nil, tags: nil, summary: nil)
        t.orgRole = "lead"
        var s = WalnutUserStatus(state: status)
        s.source = "thread"
        s.threads = threads
        t.userStatus = s
        return t
    }

    private func task(_ id: String, status: String, phase: String, userState: String?) -> WalnutTask {
        var t = WalnutTask(
            id: id, title: "t", status: status, phase: phase,
            priority: "none", project: "", dueDate: nil,
            createdAt: "2026-11-19T09:00:00Z", updatedAt: "2026-11-19T09:00:00Z",
            completedAt: nil, starred: nil, pinned: nil, tags: nil, summary: nil)
        t.userStatus = userState.map { WalnutUserStatus(state: $0) }
        return t
    }

    /// A write the test answers itself: it is held until `answer` runs.
    private final class HeldWrite: @unchecked Sendable {
        private let lock = NSLock()
        private var waiting: [CheckedContinuation<Void, Error>] = []
        private(set) var calls: [(String, OrgThreadEdit)] = []
        var count: Int { lock.withLock { calls.count } }

        func write(_ threadId: String, _ edit: OrgThreadEdit) async throws {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                lock.withLock {
                    calls.append((threadId, edit))
                    waiting.append(c)
                }
            }
        }

        func answer(_ error: Error? = nil) {
            let first: CheckedContinuation<Void, Error>? = lock.withLock { waiting.isEmpty ? nil : waiting.removeFirst() }
            if let error { first?.resume(throwing: error) } else { first?.resume() }
        }
    }

    /// Reads counted, each answering what `list` holds then.
    private final class Reads: @unchecked Sendable {
        private let lock = NSLock()
        private var list: [OrgThread]
        private var n = 0
        init(_ list: [OrgThread]) { self.list = list }
        var count: Int { lock.withLock { n } }
        func set(_ l: [OrgThread]) { lock.withLock { list = l } }
        func read() -> OrgThreadsRead {
            lock.withLock {
                n += 1
                return OrgThreadsRead(threads: list, shownCount: list.filter { $0.shown == true && $0.closed == nil }.count)
            }
        }
    }

    private func eventually(_ timeout: Double = 3, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    private let refused = APIError.server(status: 500, code: "internal", message: "no", serverHash: nil, serverContent: nil)

    /// The feed's hub the test's stores share (never the app's: a hosted test runs inside the app).
    private let signals = FeedSignals()

    private func setUpNode(threads list: [OrgThread]) async -> (TasksStore, OrgThreadsStore, HeldWrite, Reads) {
        let tasks = TasksStore(transport: MockTaskTransport())
        tasks.feedSignals = signals
        tasks.tasks = [nodeTask(threads: OrgThreadModel.counts(list, now: Date()))]
        let held = HeldWrite()
        let reads = Reads(list)
        let store = OrgThreadsStore(taskId: Self.node, cache: nil, read: { reads.read() },
                                    write: { try await held.write($0, $1) }, tasks: { tasks }, signals: signals)
        await store.load()
        return (tasks, store, held, reads)
    }

    private func shownOnRow(_ tasks: TasksStore) -> Int {
        tasks.tasks.first { $0.id == Self.node }?.userStatus?.threads?.shown ?? 0
    }

    private func openCount(_ store: OrgThreadsStore) -> Int {
        OrgThreadModel.sections(store.threads ?? [], now: Date()).open.count
    }

    // MARK: - 1. On the tap

    func testAcknowledgeMovesTheCardAndTheNodeCountBeforeTheWriteIsAnswered() async {
        let (tasks, store, held, reads) = await setUpNode(threads: [thread("th-a"), thread("th-b", state: "answered")])
        XCTAssertEqual(shownOnRow(tasks), 2)
        XCTAssertEqual(openCount(store), 2)

        let edit = Task { await store.edit("th-a", .acknowledge) }
        await eventually { held.count == 1 }
        // The write is still on its way: the card and every count already moved.
        XCTAssertEqual(openCount(store), 1, "the card left the open list on the tap")
        XCTAssertNotNil(store.threads?.first { $0.id == "th-a" }?.closed)
        XCTAssertEqual(shownOnRow(tasks), 1, "the node's row (badge, Threads switch, bar) counts one at once")
        XCTAssertEqual(tasks.tasks.first?.userStatus?.threads?.needs, 0, "the one that waited on him is gone")
        XCTAssertNil(store.notice, "his own Acknowledge says nothing: the card just goes (2026-11-25)")

        reads.set([OrgThreadModel.optimistic(thread("th-a"), .edit(.acknowledge), now: Date()), thread("th-b", state: "answered")])
        held.answer()
        await edit.value
        XCTAssertEqual(openCount(store), 1, "the server's read after it keeps it (the fold of the saved change)")
        XCTAssertNil(store.error)
    }

    func testTheLastThreadLeavingTakesTheCountToNone() async {
        let (tasks, store, held, _) = await setUpNode(threads: [thread("th-a")])
        let edit = Task { await store.edit("th-a", .snooze("2099-01-01T09:00:00.000Z")) }
        await eventually { held.count == 1 }
        XCTAssertNil(tasks.tasks.first?.userStatus?.threads, "no thread for him: no count, no red")
        XCTAssertEqual(OrgThreadModel.sections(store.threads ?? [], now: Date()).snoozed.map(\.id), ["th-a"])
        held.answer()
        await edit.value
    }

    func testARefusedWritePutsTheCardAndTheCountBackAndSaysSo() async {
        let (tasks, store, held, reads) = await setUpNode(threads: [thread("th-a"), thread("th-b")])
        let edit = Task { await store.edit("th-a", .acknowledge) }
        await eventually { held.count == 1 }
        XCTAssertEqual(shownOnRow(tasks), 1)

        held.answer(refused)
        await edit.value
        XCTAssertEqual(openCount(store), 2, "the card is back")
        XCTAssertNil(store.threads?.first { $0.id == "th-a" }?.closed)
        XCTAssertEqual(shownOnRow(tasks), 2, "the count is back")
        XCTAssertEqual(store.error, OrgThreadsStore.refusedWords)
        XCTAssertNil(store.notice, "no notice of a move that did not happen")
        XCTAssertGreaterThanOrEqual(reads.count, 2, "and the threads are read again")
    }

    func testAReadOrAFeedEventWhileTheWriteIsOutDoesNotFlipItBack() async {
        let (tasks, store, held, reads) = await setUpNode(threads: [thread("th-a"), thread("th-b")])
        let serverRow = tasks.tasks[0]
        let edit = Task { await store.edit("th-a", .acknowledge) }
        await eventually { held.count == 1 }

        // A read lands mid-write, still showing the thread open (the server has not saved yet).
        await store.load()
        XCTAssertEqual(openCount(store), 1, "the read is laid under his change")
        XCTAssertGreaterThanOrEqual(reads.count, 2)

        // The feed brings the node's row with the status from before the change...
        tasks._applyFeedMutationsForTesting([.taskUpsert(serverRow)])
        XCTAssertEqual(shownOnRow(tasks), 1, "an echo of the old status does not flip the count back")

        // ...and a status derived for something else (still 2 shown): made again over it.
        var other = serverRow
        other.userStatus?.at = "2026-11-19T10:05:00Z"
        tasks._applyFeedMutationsForTesting([.taskUpsert(other)])
        XCTAssertEqual(shownOnRow(tasks), 1, "a new status while the write is out keeps the change")
        XCTAssertEqual(tasks.tasks[0].userStatus?.at, "2026-11-19T10:05:00Z", "but takes the server's other fields")

        held.answer()
        await edit.value
        // Answered and settled: the server's own derivation wins when it comes.
        try? await Task.sleep(for: .seconds(OrgThreadsStore.settleSeconds + 0.2))
        var derived = serverRow
        derived.userStatus?.threads = WalnutThreadCounts(shown: 1, needs: 0, title: "Thread th-b", id: "th-b")
        tasks._applyFeedMutationsForTesting([.taskUpsert(derived)])
        XCTAssertEqual(tasks.tasks[0].userStatus, derived.userStatus, "the server's answer replaces the prediction")
        XCTAssertTrue(tasks.statusPredictions.isEmpty)
    }

    func testTwoActionsOnOneNodeCountBoth() async {
        let (tasks, store, held, reads) = await setUpNode(threads: [thread("th-a"), thread("th-b"), thread("th-c")])
        let first = Task { await store.edit("th-a", .acknowledge) }
        await eventually { held.count == 1 }
        let second = Task { await store.edit("th-b", .acknowledge) }
        await eventually { held.count == 2 }
        XCTAssertEqual(shownOnRow(tasks), 1)
        // The first is refused, the second still on its way: only the first comes back.
        held.answer(refused)
        await first.value
        XCTAssertEqual(openCount(store), 2)
        XCTAssertEqual(shownOnRow(tasks), 2, "counted from the list as drawn now, without the refused change")
        reads.set([thread("th-a"), OrgThreadModel.optimistic(thread("th-b"), .edit(.acknowledge), now: Date()), thread("th-c")])
        held.answer()
        await second.value
        XCTAssertEqual(openCount(store), 2)
    }

    func testAWatchShowsAtOnceAndMovesNoCount() async {
        let working = thread("th-w", state: "working", shown: false)
        let (tasks, store, held, _) = await setUpNode(threads: [thread("th-a"), working])
        XCTAssertEqual(shownOnRow(tasks), 1)
        let watch = Task { await store.edit("th-w", .watch(true)) }
        await eventually { held.count == 1 }
        XCTAssertEqual(OrgThreadModel.sections(store.threads ?? [], now: Date()).watching.first?.id, "th-w", "on Watching at once")
        // A watch moves no clock and no count: the working thread is still the node's move.
        XCTAssertEqual(shownOnRow(tasks), 1)
        XCTAssertEqual(tasks.tasks[0].userStatus?.threads?.watched ?? 0, 0)
        held.answer()
        await watch.value
    }

    /// Two taps on one thread: the first saved, the second refused. The card shows what the
    /// server holds (the first), never what it was before both.
    func testASecondTapRefusedKeepsTheFirstThatSaved() async {
        let (_, store, held, _) = await setUpNode(threads: [thread("th-a")])
        let watch = Task { await store.edit("th-a", .watch(true)) }
        await eventually { held.count == 1 }
        let unwatch = Task { await store.edit("th-a", .watch(false)) }
        await eventually { held.count == 2 }
        XCTAssertNil(store.threads?.first?.watched, "the second tap shows")
        held.answer()
        await watch.value
        XCTAssertNil(store.threads?.first?.watched, "the second tap still on its way stays over the first")
        held.answer(refused)
        await unwatch.value
        // The fake server's read still says unwatched; between the answers the card held the watch.
        XCTAssertEqual(store.error, OrgThreadsStore.refusedWords)
    }

    func testAPollMovesTheCountsWhenTheFeedIsDown() async {
        let (tasks, store, _, reads) = await setUpNode(threads: [thread("th-a")])
        store.viewerAppeared()
        defer { store.viewerLeft() }
        let mock = tasks.transport as! MockTaskTransport
        var moved = tasks.tasks[0]
        moved.userStatus?.threads = WalnutThreadCounts(shown: 2, needs: 2)
        mock.tasksResponse = TasksResponse(tasks: [moved], syncedAt: "2026-11-19T10:00:00Z")
        let first = reads.count
        await tasks.loadTasks()
        await eventually { reads.count > first }
        XCTAssertEqual(reads.count, first + 1, "a list read that moved the node's count reads its threads again")
        // Only timestamps moved: no news.
        var touched = moved
        touched.userStatus?.at = "2026-11-19T10:09:00Z"
        mock.tasksResponse = TasksResponse(tasks: [touched], syncedAt: "2026-11-19T10:00:00Z")
        await tasks.loadTasks()
        try? await Task.sleep(for: .milliseconds(450))
        XCTAssertEqual(reads.count, first + 1)
    }

    // MARK: - 2. One store per node

    func testEverySurfaceOfANodeReadsOneStore() {
        let id = "task-one-store-\(UUID().uuidString)"
        XCTAssertTrue(OrgThreadsStore.forNode(id) === OrgThreadsStore.forNode(id))
        XCTAssertFalse(OrgThreadsStore.forNode(id) === OrgThreadsStore.forNode(id + "-other"))
        for file in ["Walnut/Views/Org/OrgNodePage.swift", "Walnut/Views/Org/TaskThreadsSheet.swift"] {
            let code = (try? String(contentsOf: Self.root.appendingPathComponent(file), encoding: .utf8)) ?? ""
            XCTAssertTrue(code.contains("OrgThreadsStore.forNode("), "\(file) reads the node's one store")
            XCTAssertFalse(code.contains("OrgThreadsStore(taskId:"), "\(file) keeps no private copy")
        }
    }

    private static var root: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    // MARK: - 3. A status set by hand

    func testAReopenedTaskStopsReadingDoneOnTheTap() async throws {
        let mock = MockTaskTransport()
        let gate = CheckedContinuationGate()
        mock.gate = gate
        let store = TasksStore(transport: mock)
        let done = task("t-reopen", status: "done", phase: "COMPLETE", userState: "done")
        store.tasks = [done]

        let write = Task { try await store.updateTask(id: "t-reopen", edit: .init(status: "todo")) }
        await eventually { mock.callCount("updateTask") == 1 }
        let row = try XCTUnwrap(store.tasks.first)
        XCTAssertEqual(row.phase, "TODO", "the phase the server moves it to")
        XCTAssertEqual(TeamStatusModel.state(of: row), .waiting, "the dot and every count read it open at once")
        XCTAssertEqual(row.userStatus?.kind, "not-started")

        // The feed's echo of the old row mid-write never flips it back.
        store._applyFeedMutationsForTesting([.taskUpsert(done)])
        XCTAssertEqual(TeamStatusModel.state(of: store.tasks[0]), .waiting)

        gate.open()
        _ = try await write.value
        XCTAssertEqual(TeamStatusModel.state(of: store.tasks[0]), .waiting)
        // The server's derivation arrives: it wins.
        var derived = task("t-reopen", status: "todo", phase: "TODO", userState: "waiting")
        derived.userStatus?.kind = "you"
        store._applyFeedMutationsForTesting([.taskUpsert(derived)])
        XCTAssertEqual(store.tasks[0].userStatus?.kind, "you")
    }

    func testARefusedStatusWriteRestoresTheRowAndItsStatus() async {
        let mock = MockTaskTransport()
        let gate = CheckedContinuationGate()
        mock.gate = gate
        mock.error = refused
        let store = TasksStore(transport: mock)
        let done = task("t-refused", status: "done", phase: "COMPLETE", userState: "done")
        store.tasks = [done]
        let write = Task { try? await store.updateTask(id: "t-refused", edit: .init(status: "todo")) }
        await eventually { mock.callCount("updateTask") == 1 }
        XCTAssertEqual(TeamStatusModel.state(of: store.tasks[0]), .waiting)
        // A feed echo mid-write replays the edit on the server's row (a new `updatedAt`): the
        // refusal still takes that row back.
        store._applyFeedMutationsForTesting([.taskUpsert(done)])
        XCTAssertEqual(store.tasks[0].status, "todo")
        gate.open()
        _ = await write.value
        XCTAssertEqual(store.tasks[0], done, "the row and its status are the server's again")
        XCTAssertTrue(store.statusPredictions.isEmpty)
    }

    func testAPhaseSetByHandIsLeftToTheServerWhereItsAnswerDoesNotFollowThePhase() {
        var running = task("t-run", status: "todo", phase: "TODO", userState: "working")
        running.liveActivity = WalnutLiveActivity(kind: "tool", tool: "Read", since: "2026-11-19T10:00:00Z")
        XCTAssertEqual(TasksStore.predictedStatus(forPhase: "IN_PROGRESS", fromPhase: "TODO", row: running, hasSession: true),
                       running.userStatus, "a turn runs: it reads Working whatever the phase")
        let fresh = task("t-new", status: "todo", phase: "WAITING", userState: "waiting")
        XCTAssertEqual(TasksStore.predictedStatus(forPhase: "IN_PROGRESS", fromPhase: "WAITING", row: fresh, hasSession: true)?.state,
                       "waiting", "In progress by hand starts no turn")
        XCTAssertNil(TasksStore.phase(for: "in_progress", from: "NEED_ACTION"), "Need action already means in progress")
        XCTAssertEqual(TasksStore.phase(for: "todo", from: "COMPLETE"), "TODO")
    }

    // MARK: - 4. Live

    func testTheFeedFramesAndAMovedStatusReadTheShownNodeAgain() async {
        let (tasks, store, _, reads) = await setUpNode(threads: [thread("th-a")])
        XCTAssertEqual(reads.count, 1)
        // Not on screen: a signal costs no read.
        signals.post(.threadsChanged(taskId: Self.node))
        try? await Task.sleep(for: .milliseconds(450))
        XCTAssertEqual(reads.count, 1)

        store.viewerAppeared()
        defer { store.viewerLeft() }
        reads.set([thread("th-a"), thread("th-new")])
        // A newer server's frame, through the store that applies the feed.
        tasks._applyFeedMutationsForTesting([.threadsChanged(taskId: Self.node), .threadsChanged(taskId: Self.node)])
        await eventually { reads.count >= 2 }
        XCTAssertEqual(reads.count, 2, "a burst is one read")
        XCTAssertEqual(openCount(store), 2, "the thread made at the Mac is on the page")

        // An older server: only the node's row moves.
        var moved = tasks.tasks[0]
        moved.userStatus?.threads = WalnutThreadCounts(shown: 3, needs: 3)
        tasks._applyFeedMutationsForTesting([.taskUpsert(moved)])
        await eventually { reads.count >= 3 }
        XCTAssertEqual(reads.count, 3)

        // Another node's frame is not this node's news.
        tasks._applyFeedMutationsForTesting([.threadsChanged(taskId: "task-someone-else")])
        try? await Task.sleep(for: .milliseconds(450))
        XCTAssertEqual(reads.count, 3)
    }

    func testTheOrgTreeFollowsTheFeedWhileShown() async {
        final class Box: @unchecked Sendable { var n = 0 }
        let box = Box()
        let org = OrgTreeStore(read: {
            box.n += 1
            return OrgTreeWire(main: nil, projects: [], counts: OrgCountsWire(needsYou: box.n))
        }, signals: signals)
        await org.load()
        XCTAssertEqual(org.tree?.counts.needsYou, 1)
        org.heard(.statusChanged(taskId: "any"))
        try? await Task.sleep(for: .milliseconds(550))
        XCTAssertEqual(box.n, 1, "shown nowhere: no read")
        org.viewerAppeared()
        defer { org.viewerLeft() }
        signals.post(.statusChanged(taskId: "t1"))
        signals.post(.statusChanged(taskId: "t2"))
        signals.post(.threadsChanged(taskId: "t3"))
        await eventually { box.n >= 2 }
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(box.n, 2, "three moves, one read")
        XCTAssertEqual(org.tree?.counts.needsYou, 2, "the counts follow")
    }

    /// A read that brings what is shown writes nothing the surfaces observe: the store reads
    /// again on every status that moves, and a drawer row redrawn under a finger loses the
    /// long-press menu it was about to show (DirectorsUITests).
    func testAReadThatChangesNothingRedrawsNothing() async {
        final class Box: @unchecked Sendable { var needs = 1; var fail = false }
        let box = Box()
        let org = OrgTreeStore(read: {
            if box.fail { throw APIError.badResponse }
            return OrgTreeWire(main: nil, projects: [], counts: OrgCountsWire(needsYou: box.needs))
        }, signals: signals)
        await org.load()

        func redraws(_ body: () async -> Void) async -> Bool {
            var changed = false
            withObservationTracking {
                _ = (org.tree, org.available, org.loading, org.failure, org.answered)
            } onChange: { changed = true }
            await body()
            return changed
        }
        let sameAgain = await redraws { await org.load() }
        XCTAssertFalse(sameAgain, "the same tree again redrew the org's surfaces")
        box.needs = 2
        let moved = await redraws { await org.load() }
        XCTAssertTrue(moved, "a count that moved did not redraw")
        XCTAssertEqual(org.tree?.counts.needsYou, 2)
        box.fail = true
        await org.load()
        let sameFailure = await redraws { await org.load() }
        XCTAssertFalse(sameFailure, "the same failure again redrew the org's surfaces")
        XCTAssertEqual(org.tree?.counts.needsYou, 2, "a failed read keeps what was shown")
    }

    func testTheInboxReadsAgainOnTheFeedsWord() async {
        let suite = "OrgThreadsInstantTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let json: [String: Any] = ["id": "lt-1", "subject": "A letter", "type": "info",
                                   "createdAt": Date().timeIntervalSince1970 * 1000, "read": false,
                                   "pinned": false, "archived": false]
        var letter = try! JSONDecoder().decode(Letter.self, from: JSONSerialization.data(withJSONObject: json))
        let transport = MockInboxTransport([letter])
        let inbox = InboxStore(transport: transport, defaults: defaults, signals: signals)
        await inbox.refresh()
        XCTAssertEqual(inbox.unreadCount, 1)

        // Read on the Mac: the feed says the inbox changed, the badge follows.
        letter.read = true
        transport.setServer([letter])
        let tasks = TasksStore(transport: MockTaskTransport())
        tasks.feedSignals = signals
        tasks._applyFeedMutationsForTesting([.inboxChanged])
        await eventually { inbox.unreadCount == 0 }
        XCTAssertEqual(inbox.unreadCount, 0)

        // Read here: the badge drops on the tap, before the write is answered.
        letter.read = false
        transport.setServer([letter])
        await inbox.refresh()
        let gate = CheckedContinuationGate()
        transport.readGate = gate
        inbox.markReadOnOpen(id: "lt-1")
        XCTAssertEqual(inbox.unreadCount, 0, "on the tap")
        gate.open()
    }

    // MARK: - Pure rules

    func testTheCountsAreTheServersRule() {
        // A watched thread that waits on him (Done, unread) counts and wears the eye; a watched one
        // that is the node's move does not count (thread-groups.ts threadsForHim).
        let watched: OrgThread = {
            var t = thread("th-p", state: "answered", shown: true, updatedAt: "2026-11-19T08:00:00.000Z")
            t.watched = .init(at: "2026-11-19T08:30:00.000Z", by: "human")
            return t
        }()
        let watchedWorking: OrgThread = {
            var t = thread("th-ww", state: "working", shown: true, updatedAt: "2026-11-19T08:10:00.000Z")
            t.watched = .init(at: "2026-11-19T08:40:00.000Z", by: "human")
            t.counted = false
            return t
        }()
        let list = [thread("th-n", state: "needs"), thread("th-ans", state: "answered", updatedAt: "2026-11-19T11:00:00.000Z"),
                    watched, watchedWorking, thread("th-quiet", state: "working", shown: false)]
        let c = OrgThreadModel.counts(list, now: Date())
        XCTAssertEqual(c.shown, 3)
        XCTAssertEqual(c.needs, 1)
        XCTAssertEqual(c.watched, 1)
        XCTAssertEqual(c.id, "th-n", "the newest waiting on him names the row")
        XCTAssertFalse(c.titleWatched)
        let noNeeds = OrgThreadModel.counts([watched, list[1]], now: Date())
        XCTAssertEqual(noNeeds.id, "th-p", "else the newest watch")
        XCTAssertTrue(noNeeds.titleWatched)
        // The server's own word wins where it sent one: a listed thread it does not count is no number.
        let listedNotCounted: OrgThread = { var t = thread("th-l", state: "needs", shown: true); t.counted = false; return t }()
        XCTAssertEqual(OrgThreadModel.counts([listedNotCounted], now: Date()).shown, 0)
    }

    func testEachActionLandsWhereTheServerPutsIt() {
        let now = Date()
        let t = thread("th-a", state: "answered")
        let acked = OrgThreadModel.optimistic(t, .edit(.acknowledge), now: now)
        XCTAssertEqual(acked.closed?.how, "acked")
        XCTAssertEqual(OrgThreadModel.movedNotice("th-a", threads: [acked], now: now), "Closed. It is under Closed")
        let snoozed = OrgThreadModel.optimistic(t, .edit(.snooze("2099-01-01T00:00:00.000Z")), now: now)
        XCTAssertTrue(OrgThreadModel.snoozedNow(snoozed, now: now))
        XCTAssertFalse(OrgThreadModel.inView(snoozed, shared: [], now: now))
        let reopened = OrgThreadModel.optimistic(acked, .edit(.reopen), now: now)
        XCTAssertNil(reopened.closed)
        XCTAssertTrue(OrgThreadModel.inView(reopened, shared: [], now: now), "an answered thread is his again")
        let followed = OrgThreadModel.optimistic(t, .followUp, now: now)
        XCTAssertEqual(followed.state, "working")
        XCTAssertFalse(OrgThreadModel.inView(followed, shared: [], now: now))
    }
}
