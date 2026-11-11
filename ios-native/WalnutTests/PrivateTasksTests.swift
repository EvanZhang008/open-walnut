import XCTest
@testable import Walnut

/// Local-only tasks in a project that syncs to an outside service (server
/// `src/core/private-tasks/`): what the phone reads (a task's `source` and `sync_hold`, which
/// projects sync), what its task menu offers (Make local, Sync to <service>) and what its create
/// pages send (`local`, a launch's `sync`). The rules are the web's (`private-task-model.ts`).
@MainActor
final class PrivateTasksTests: XCTestCase {

    private func task(
        _ id: String, project: String = "Atlas", source: String? = nil, hold: WalnutSyncHold? = nil
    ) -> WalnutTask {
        WalnutTask(
            id: id, title: "Quarter plan", status: "todo", phase: "TODO",
            priority: "none", project: project, dueDate: nil,
            createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
            completedAt: nil, starred: nil, pinned: nil, tags: nil, summary: nil,
            source: source, syncHold: hold
        )
    }

    private let sources = [WalnutProjectSource(name: "Atlas", source: "plugin-a", sourceName: "Tracker"),
                           WalnutProjectSource(name: "Home", source: "local")]

    // MARK: - Standing (the web's syncStanding)

    func testStandingFollowsTheWebRules() {
        XCTAssertEqual(SyncStanding.of(task("a", source: "plugin-a"), projectSource: "plugin-a"),
                       .synced(service: "plugin-a"))
        let checking = WalnutSyncHold(state: "checking", target: "plugin-a")
        XCTAssertEqual(SyncStanding.of(task("b", hold: checking), projectSource: "plugin-a"),
                       .checking(service: "plugin-a", hold: checking))
        let chosen = WalnutSyncHold(state: "chosen", target: "plugin-a", reason: "You made it local", outside: "kept")
        XCTAssertEqual(SyncStanding.of(task("c", hold: chosen), projectSource: "plugin-a"),
                       .kept(service: "plugin-a", hold: chosen))
        // A local task in a project that syncs, with no reason recorded.
        XCTAssertEqual(SyncStanding.of(task("d"), projectSource: "plugin-a"), .kept(service: "plugin-a", hold: nil))
        // A project that does not sync, and the Inbox: nothing to choose.
        XCTAssertEqual(SyncStanding.of(task("e", project: "Home"), projectSource: "local"), .local)
        XCTAssertEqual(SyncStanding.of(task("f", project: ""), projectSource: "plugin-a"), .local)
        XCTAssertEqual(SyncStanding.of(task("g"), projectSource: nil), .local)
    }

    func testTheLinesSayWhatTheWebSays() {
        let name: (String) -> String = { $0 == "plugin-a" ? "Tracker" : $0 }
        XCTAssertEqual(SyncStanding.synced(service: "plugin-a").summary(name), "Syncs to Tracker")
        let kept = SyncStanding.kept(service: "plugin-a", hold: WalnutSyncHold(
            state: "private", target: "plugin-a", reason: "It matches a private word"))
        XCTAssertEqual(kept.summary(name), "Local, not in Tracker")
        XCTAssertEqual(kept.keptLine(name), "Kept out of Tracker: It matches a private word")
        XCTAssertEqual(SyncStanding.kept(service: "plugin-a", hold: nil).keptLine(name), "Local, not synced to Tracker")
        XCTAssertEqual(SyncStanding.checking(service: "plugin-a", hold: WalnutSyncHold(state: "checking", target: "plugin-a"))
            .keptLine(name), "Checking whether it is private before it goes to Tracker")
        XCTAssertTrue(SyncStanding.kept(service: "plugin-a", hold: WalnutSyncHold(state: "chosen", target: "plugin-a", outside: "kept")).outsideCopyKept)
        XCTAssertFalse(SyncStanding.kept(service: "plugin-a", hold: WalnutSyncHold(state: "chosen", target: "plugin-a", outside: "archived")).outsideCopyKept)
        XCTAssertTrue(SyncStanding.kept(service: "plugin-a", hold: nil).keptWithoutHold)
    }

    // MARK: - Wire

    func testTheRowAndTheProjectsDecode() throws {
        let row = try JSONDecoder().decode(WalnutTask.self, from: Data("""
        {"id":"t1","title":"x","status":"todo","phase":"TODO","priority":"none","project":"Atlas",
         "sync_hold":{"state":"chosen","target":"plugin-a","reason":"You made it local","outside":"kept"}}
        """.utf8))
        XCTAssertNil(row.source)
        XCTAssertEqual(row.syncHold, WalnutSyncHold(state: "chosen", target: "plugin-a", reason: "You made it local", outside: "kept"))
        let synced = try JSONDecoder().decode(WalnutTask.self, from: Data("""
        {"id":"t2","title":"x","status":"todo","phase":"TODO","priority":"none","project":"Atlas","source":"plugin-a"}
        """.utf8))
        XCTAssertEqual(synced.source, "plugin-a")
        // A projects row carries counts and more; only the three fields are read, and an older
        // server's row without source_name still decodes.
        struct Wrapper: Decodable { let projects: [WalnutProjectSource] }
        let rows = try JSONDecoder().decode(Wrapper.self, from: Data("""
        {"projects":[{"name":"Atlas","source":"plugin-a","source_name":"Tracker","favorite":false,"counts":{"todo":1}},
                     {"name":"Home","source":"local"}],"inbox":{"counts":{}}}
        """.utf8)).projects
        XCTAssertEqual(rows, sources)
    }

    func testALaunchSendsSyncOnlyForTheServiceInAProject() throws {
        func sync(_ body: WalnutAPI.CreateSessionBody) throws -> Any? {
            let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any]
            return json?["sync"]
        }
        let toService = WalnutAPI.createSessionBody(cwd: "/w", host: nil, message: "hi", taskId: nil,
                                                     mode: nil, model: nil, project: "Atlas", syncToProject: true)
        XCTAssertEqual(try sync(toService) as? String, "project")
        // Local is the server's rule for a launch: nothing is sent.
        XCTAssertNil(try sync(WalnutAPI.createSessionBody(cwd: "/w", host: nil, message: "hi", taskId: nil,
                                                          mode: nil, model: nil, project: "Atlas")))
        // The Inbox, or a launch from an existing task (its source is decided): never.
        XCTAssertNil(try sync(WalnutAPI.createSessionBody(cwd: "/w", host: nil, message: "hi", taskId: nil,
                                                          mode: nil, model: nil, project: "", syncToProject: true)))
        XCTAssertNil(try sync(WalnutAPI.createSessionBody(cwd: "/w", host: nil, message: "hi", taskId: "t1",
                                                          mode: nil, model: nil, project: "Atlas", syncToProject: true)))
    }

    // MARK: - Store

    func testTheStoreKnowsWhichProjectsSyncAndTheServiceName() async {
        let mock = MockTaskTransport()
        mock.projectSourcesResult = sources
        let store = TasksStore(transport: mock)
        await store.loadProjectSources()
        XCTAssertEqual(store.projectService("Atlas"), "plugin-a")
        XCTAssertEqual(store.projectService("atlas "), "plugin-a", "names compare as the server does: case-folded")
        XCTAssertNil(store.projectService("Home"))
        XCTAssertNil(store.projectService(""))
        XCTAssertNil(store.projectService("New project"))
        XCTAssertEqual(store.serviceName("plugin-a"), "Tracker")
        XCTAssertEqual(store.serviceName("plugin-b"), "plugin-b", "an unknown service reads as its id")
        XCTAssertEqual(store.syncStanding(task("a", source: "plugin-a")), .synced(service: "plugin-a"))
    }

    func testAnOlderServerOffersNoLocalChoice() async {
        // Before private tasks a server sent `source` without `source_name`, ignored `local` and
        // had no make-local route: nothing may offer Local or a service there.
        let mock = MockTaskTransport()
        mock.projectSourcesResult = [WalnutProjectSource(name: "Atlas", source: "plugin-a")]
        let store = TasksStore(transport: mock)
        await store.loadProjectSources()
        XCTAssertNil(store.projectService("Atlas"))
        XCTAssertEqual(store.syncStanding(task("t1")), .local)
    }

    func testAFailedSourcesReadKeepsWhatTheStoreKnew() async {
        let mock = MockTaskTransport()
        mock.projectSourcesResult = sources
        let store = TasksStore(transport: mock)
        await store.loadProjectSources()
        mock.errorsByEndpoint["projectSources"] = APIError.badResponse
        await store.loadProjectSources()
        XCTAssertEqual(store.projectService("Atlas"), "plugin-a")
    }

    func testMakeLocalReplacesTheRowAndSaysWhatHappened() async {
        let mock = MockTaskTransport()
        mock.projectSourcesResult = sources
        let hold = WalnutSyncHold(state: "chosen", target: "plugin-a", reason: "You made it local", outside: "archived")
        mock.syncChangeResult = { id, _ in
            SyncChangeAnswer(task: self.task(id, hold: hold),
                             outcome: "The task no longer syncs to Tracker. Its copy in Tracker was archived.")
        }
        let store = TasksStore(transport: mock)
        await store.loadProjectSources()
        store.tasks = [task("t1", source: "plugin-a")]
        await store.makeLocal(taskId: "t1", outside: .archive)
        XCTAssertEqual(mock.lastCall("makeTaskLocal")?.args, ["t1", "archive"])
        await store.loadTasks()
        XCTAssertEqual(store.tasks.map(\.id), ["t1"])
        XCTAssertNil(store.tasks.first?.source)
        XCTAssertEqual(store.tasks.first?.syncHold, hold)
        XCTAssertEqual(store.tasks.first.map { store.syncStanding($0) }, SyncStanding.kept(service: "plugin-a", hold: hold))
        XCTAssertEqual(store.transientNotice, "The task no longer syncs to Tracker. Its copy in Tracker was archived.")
        XCTAssertNil(store.transientError)
    }

    func testARefusedChangeLeavesTheRowAndShowsWhy() async {
        let mock = MockTaskTransport()
        mock.errorsByEndpoint["syncTaskToProject"] = APIError.server(
            status: 409, code: "project_local", message: "Its project does not sync to an outside service.",
            serverHash: nil, serverContent: nil)
        let store = TasksStore(transport: mock)
        let before = task("t1", hold: WalnutSyncHold(state: "chosen", target: "plugin-a"))
        store.tasks = [before]
        await store.syncToProject(taskId: "t1")
        XCTAssertEqual(store.tasks[0], before)
        XCTAssertEqual(store.transientError, "Sync not changed: Its project does not sync to an outside service.")
        XCTAssertNil(store.transientNotice)
    }

    func testSyncToProjectAndTheOutsideCopy() async {
        let mock = MockTaskTransport()
        mock.projectSourcesResult = sources
        mock.syncChangeResult = { id, action in
            action == "sync-to-project"
                ? SyncChangeAnswer(task: self.task(id, source: "plugin-a"), service: "Tracker")
                : SyncChangeAnswer(task: self.task(id, hold: WalnutSyncHold(state: "chosen", target: "plugin-a", outside: "neutralized")))
        }
        let store = TasksStore(transport: mock)
        await store.loadProjectSources()
        store.tasks = [task("t1", hold: WalnutSyncHold(state: "chosen", target: "plugin-a", outside: "kept"))]
        await store.changeOutsideCopy(taskId: "t1", action: .neutralize)
        XCTAssertEqual(mock.lastCall("changeOutsideCopy")?.args, ["t1", "neutralize"])
        XCTAssertEqual(store.transientNotice, "Its copy in Tracker was neutralized and archived")
        await store.syncToProject(taskId: "t1")
        XCTAssertEqual(store.tasks.first?.source, "plugin-a")
        XCTAssertEqual(store.transientNotice, "Sent to Tracker")
        // The list reload every change ends with brings the same row back, whenever it lands.
        await store.loadTasks()
        XCTAssertEqual(store.tasks.map(\.id), ["t1"])
        XCTAssertEqual(store.tasks.first?.source, "plugin-a")
    }

    func testTheLocalChoiceRidesTheCreate() async throws {
        let mock = MockTaskTransport()
        let store = TasksStore(transport: mock)
        _ = try await store.createTask(title: "Garden plan", project: "Atlas", local: true)
        XCTAssertEqual(mock.lastCall("createTask")?.args.last, "local=true")
        // The draft's save as todo, Local in a project that syncs.
        _ = try await NewSessionChatView.createTodo(from: "Garden plan two", project: "Atlas", local: true, in: store)
        XCTAssertEqual(mock.lastCall("createTask")?.args.last, "local=true")
        // Without the choice nothing extra goes on the wire (the server's own rule).
        _ = try await store.createTask(title: "Fix the release script", project: "Atlas")
        XCTAssertNotEqual(mock.lastCall("createTask")?.args.last, "local=true")
    }

    // MARK: - Every copy of a row carries every field (guard for the whole class)

    /// A row with every field set. A new field of WalnutTask must be set here too, or the first
    /// assertion fails, so every copy below is checked for it.
    private func fullRow() throws -> WalnutTask {
        try JSONDecoder().decode(WalnutTask.self, from: Data("""
        {"id":"t1","title":"x","status":"todo","phase":"TODO","priority":"none","project":"Atlas",
         "due_date":"2026-11-02","created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z",
         "completed_at":"2026-11-01T00:00:00Z","starred":true,"pinned":true,"tags":["a"],"summary":"s",
         "start_date":"2026-11-01","end_date":"2026-11-02","unread":true,"parent_task_id":"p1",
         "user_status":{"state":"working"},"org_role":"lead",
         "live_activity":{"kind":"tool","since":"2026-11-01T00:00:00Z"},
         "result_report":{"result":"r"},"team_stop":{"at":"2026-11-01T00:00:00Z"},
         "wait_until":"2026-11-03T00:00:00Z","watched_at":"2026-11-01T00:00:00Z",
         "source":"plugin-a","sync_hold":{"state":"chosen","target":"plugin-a"},
         "summary_session_id":"s-summary","last_words":{"text":"w","at":"2026-11-01T00:00:00Z","session_id":"s-last"}}
        """.utf8))
    }

    func testEveryCopyOfARowKeepsEveryField() throws {
        let row = try fullRow()
        for child in Mirror(reflecting: row).children {
            XCTAssertFalse("\(child.value)" == "nil", "set \(child.label ?? "?") in fullRow() so its copies are checked")
        }
        XCTAssertEqual(TasksStore.withPinned(row, row.pinned), row)
        let edited = TasksStore.applyEdit(TasksStore.TaskEdit(), to: row)
        for (a, b) in zip(Mirror(reflecting: row).children, Mirror(reflecting: edited).children)
        where a.label != "updatedAt" {
            XCTAssertEqual("\(a.value)", "\(b.value)", "applyEdit drops \(a.label ?? "?")")
        }
    }
}
