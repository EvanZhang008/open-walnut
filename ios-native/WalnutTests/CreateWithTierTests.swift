import XCTest
@testable import Walnut

/// Filing a task AT CREATE TIME: the `pinned` + `focus_tier` pair on
/// `POST /api/v1/tasks`, the seed a group header's `+` hands down, and the
/// optimistic placement the store applies before the projection catches up.
///
/// The bug class these gate is specific: a task the user filed into Focus
/// quietly ending up in Satellite. Every assertion below is about the
/// difference between those two outcomes being VISIBLE (a value on the wire,
/// an error the human sees) rather than a silent downgrade.
@MainActor
final class CreateWithTierTests: XCTestCase {

    private func customTiers(_ pairs: [(String, String)]) -> [FocusTierInfo] {
        pairs.map { FocusTierInfo(id: $0.0, label: $0.1) }
    }

    // MARK: - TaskPinChoice → create body

    /// Rule 1: a tier IMPLIES pinned, so `pinned` is OMITTED beside it. Sending
    /// `pinned: false` with a tier is a 400 by contract, and sending
    /// `pinned: true` is redundant — omission is the only correct shape.
    func testTierOmitsPinnedFromTheBody() {
        let choice = TaskPinChoice.tier("focus")
        XCTAssertNil(choice.wirePinned, "a tier implies pinned — the key must not ride along")
        XCTAssertEqual(choice.wireFocusTier, "focus")
    }

    func testUnspecifiedSendsNeitherKey() {
        let choice = TaskPinChoice.unspecified
        XCTAssertNil(choice.wirePinned, "omitted = the old behavior, server default applies")
        XCTAssertNil(choice.wireFocusTier)
    }

    func testNotPinnedSendsPinnedFalseAndNoTier() {
        let choice = TaskPinChoice.notPinned
        XCTAssertEqual(choice.wirePinned, false)
        XCTAssertNil(choice.wireFocusTier, "pinned:false + a tier is a 400 — never send both")
    }

    /// Rule 2: `satellite` is a legitimate INPUT (it rides the wire) even though
    /// the server stores it as pinned-with-no-tier. The phone must not
    /// pre-normalize it away, or "Satellite" and "server default" would become
    /// indistinguishable at the picker.
    func testSatelliteRidesTheWireAsATier() {
        let choice = TaskPinChoice.tier("satellite")
        XCTAssertEqual(choice.wireFocusTier, "satellite")
        XCTAssertNil(choice.wirePinned)
    }

    func testCustomTierRidesAsItsId() {
        XCTAssertEqual(TaskPinChoice.tier("ct_abc12345").wireFocusTier, "ct_abc12345")
    }

    // MARK: - Resolvability (rule 3: unknown tier ≠ silent Satellite)

    func testBuiltinsAndRegisteredCustomTiersResolve() {
        let builtins = TasksStore.builtinTiers.map(\.id)
        let custom = ["ct_abc12345"]
        for id in builtins + custom {
            XCTAssertTrue(
                TaskPinChoice.tier(id).isResolvable(builtinIds: builtins, customTierIds: custom),
                "\(id) is a valid tier"
            )
        }
    }

    func testUnknownTierIsNotResolvableRatherThanDowngraded() {
        let choice = TaskPinChoice.tier("ct_deleted99")
        XCTAssertFalse(
            choice.isResolvable(builtinIds: TasksStore.builtinTiers.map(\.id), customTierIds: []),
            "a stale custom tier must be reported, never quietly become Satellite"
        )
        // And it is NOT rewritten to something acceptable behind the scenes.
        XCTAssertEqual(choice.wireFocusTier, "ct_deleted99")
    }

    func testUnspecifiedAndNotPinnedAreAlwaysResolvable() {
        XCTAssertTrue(TaskPinChoice.unspecified.isResolvable(builtinIds: [], customTierIds: []))
        XCTAssertTrue(TaskPinChoice.notPinned.isResolvable(builtinIds: [], customTierIds: []))
    }

    // MARK: - Seed-from-header logic

    /// The list renders `project == ""` under the header "Inbox", so the seed
    /// must map that title BACK to the empty project — otherwise the `+` on the
    /// Inbox header would create a project literally named "Inbox".
    func testInboxHeaderSeedsTheEmptyProject() {
        let seed = NewTaskSeed.project("Inbox")
        XCTAssertEqual(seed.project, "")
        XCTAssertEqual(seed.pin, .unspecified)
    }

    func testProjectHeaderSeedsThatProjectAndLeavesPinAlone() {
        let seed = NewTaskSeed.project("marina")
        XCTAssertEqual(seed.project, "marina")
        XCTAssertEqual(seed.pin, .unspecified,
            "adding under a project is about the project — the pin default is not the user's call here")
    }

    func testTierHeaderSeedsThatTierAndNoProject() {
        let seed = NewTaskSeed.tier("focus")
        XCTAssertEqual(seed.pin, .tier("focus"))
        XCTAssertEqual(seed.project, "", "a tier says where on the board, not which project")
    }

    /// The list tracks WHICH header's add row is open by seed identity, so the
    /// same header re-derived on a later body pass must compare equal (an
    /// unstable id would collapse the open row mid-typing) and two different
    /// headers must not collide.
    func testSeedIdentityIsStablePerGroupAndDistinctAcrossGroups() {
        XCTAssertEqual(NewTaskSeed.project("marina"), NewTaskSeed.project("marina"))
        XCTAssertEqual(NewTaskSeed.tier("focus").id, NewTaskSeed.tier("focus").id)
        XCTAssertNotEqual(NewTaskSeed.tier("focus").id, NewTaskSeed.tier("backlog").id)
        XCTAssertNotEqual(NewTaskSeed.project("marina").id, NewTaskSeed.project("acme").id)
        // A project named like a tier id can't shadow the tier group.
        XCTAssertNotEqual(NewTaskSeed.project("focus").id, NewTaskSeed.tier("focus").id)
    }

    /// The seed id is also the `+`'s accessibility-identifier suffix, and Maestro
    /// matches ids as REGEXES — so any regex metacharacter in a project name makes
    /// the button unaddressable (a literal `|` separator turned
    /// `tasks.groupAdd.default|marina` into an alternation and the `+` could not be
    /// tapped at all; caught driving the real simulator, not by a unit test).
    func testSeedIdIsRegexSafeForAutomation() {
        let hostile = ["a|b", "Work (2026)", "v1.2", "c++", "a[b]", "x*y", "a?b", "^z$"]
        for name in hostile {
            let id = NewTaskSeed.project(name).id
            XCTAssertNil(
                id.rangeOfCharacter(from: CharacterSet(charactersIn: "|()[]{}.*+?^$\\")),
                "\(name) produced a regex-unsafe id: \(id)"
            )
        }
        // Real ids stay readable, so a failing flow still says which group it was.
        XCTAssertEqual(NewTaskSeed.project("marina").id, "default_marina")
        XCTAssertEqual(NewTaskSeed.tier("focus").id, "focus_")
        XCTAssertEqual(NewTaskSeed.project("Inbox").id, "default_",
            "the Inbox header's empty project still yields a usable suffix")
    }

    // MARK: - Store create: what reaches the wire

    func testCreateFromFocusHeaderSendsFocusNotSatellite() async throws {
        let mock = MockTaskTransport()
        let store = TasksStore(transport: mock)
        _ = try await store.createTask(title: "ship it", pin: .tier("focus"))

        let call = mock.calls.first { $0.name == "createTask" }
        XCTAssertEqual(call?.args[4], "-", "pinned omitted (the tier implies it)")
        XCTAssertEqual(call?.args[5], "focus", "the tier the user picked, verbatim")
    }

    func testCreateWithoutAPinSendsNeitherKey() async throws {
        let mock = MockTaskTransport()
        let store = TasksStore(transport: mock)
        _ = try await store.createTask(title: "plain")

        let call = mock.calls.first { $0.name == "createTask" }
        XCTAssertEqual(call?.args[4], "-")
        XCTAssertEqual(call?.args[5], "-", "an omitted field is byte-for-byte the old behavior")
    }

    func testCreateNotPinnedSendsPinnedFalse() async throws {
        let mock = MockTaskTransport()
        let store = TasksStore(transport: mock)
        _ = try await store.createTask(title: "off the board", pin: .notPinned)

        let call = mock.calls.first { $0.name == "createTask" }
        XCTAssertEqual(call?.args[4], "false")
        XCTAssertEqual(call?.args[5], "-")
    }

    // MARK: - Store create: optimistic placement

    /// The row must land in the RIGHT GROUP on the first frame: the tier map is
    /// what the group headers read, so a task born in Focus that isn't in the
    /// map renders under Satellite and then hops.
    func testCreatedRowCarriesItsTierImmediately() async throws {
        let mock = MockTaskTransport()
        mock.createdTaskId = "t-focus-1"
        let store = TasksStore(transport: mock)
        _ = try await store.createTask(title: "ship it", pin: .tier("focus"))

        XCTAssertEqual(store.tierId(for: "t-focus-1"), "focus")
        XCTAssertEqual(store.tasks.first?.pinned, true, "a tier implies pinned locally too")
        XCTAssertEqual(store.lastCreatedTaskId, "t-focus-1")
        XCTAssertTrue(store.pendingCreatedIds.contains("t-focus-1"),
            "REPLICA refreshes must keep the row until the projection has it")
    }

    /// Rule 2, end to end: the 201 for an explicit `satellite` omits
    /// `focus_tier`, and that absence is NOT a failure — the local map still
    /// says Satellite, because that is what `tierMap` derives for a pinned row
    /// in no explicit bucket. The two agree, so nothing flickers.
    func testSatelliteCreateStillResolvesToSatelliteLocally() async throws {
        let mock = MockTaskTransport()
        mock.createdTaskId = "t-sat-1"
        let store = TasksStore(transport: mock)
        let created = try await store.createTask(title: "someday", pin: .tier("satellite"))

        XCTAssertEqual(created.pinned, true, "pinned, with no tier stored — that IS Satellite")
        XCTAssertEqual(store.tierId(for: "t-sat-1"), "satellite")
        XCTAssertEqual(store.tierBadge(for: created), "Satellite")
    }

    func testCreatedRowInheritsTheSeedProject() async throws {
        let mock = MockTaskTransport()
        mock.createdTaskId = "t-proj-1"
        let store = TasksStore(transport: mock)
        _ = try await store.createTask(title: "in a project", project: "marina")

        XCTAssertEqual(store.tasks.first?.project, "marina")
        let call = mock.calls.first { $0.name == "createTask" }
        XCTAssertEqual(call?.args[1], "marina")
    }

    /// A rejected tier (400) must leave NOTHING behind: no ghost row, no tier
    /// map entry, no locate-me flash pointing at a task that doesn't exist. The
    /// error is the whole outcome, and the caller shows it.
    func testRejectedTierLeavesNoOptimisticStateAndThrows() async {
        let mock = MockTaskTransport()
        mock.errorsByEndpoint["createTask"] = APIError.server(
            status: 400, code: "bad_request",
            message: #"unknown focus_tier "ct_deleted99". Valid tiers: focus, satellite, backlog, wait"#,
            serverHash: nil, serverContent: nil
        )
        let store = TasksStore(transport: mock)

        do {
            _ = try await store.createTask(title: "doomed", pin: .tier("ct_deleted99"))
            XCTFail("an unknown tier must throw, never silently downgrade to Satellite")
        } catch {
            XCTAssertEqual((error as? APIError)?.code, "bad_request")
        }
        XCTAssertTrue(store.tasks.isEmpty, "no ghost row for a create that never happened")
        XCTAssertTrue(store.taskTiers.isEmpty)
        XCTAssertNil(store.lastCreatedTaskId)
        XCTAssertTrue(store.pendingCreatedIds.isEmpty)
    }

    // MARK: - Quick add through a group's add row

    func testQuickAddFromATierHeaderFilesInThatTierInOneWrite() async throws {
        let mock = MockTaskTransport()
        mock.createdTaskId = "t-qa-1"
        let store = TasksStore(transport: mock)
        _ = try await store.quickAdd("ship the report", seed: .tier("focus"))

        let call = mock.calls.first { $0.name == "createTask" }
        XCTAssertEqual(call?.args[5], "focus", "the tier rides the CREATE, not a follow-up")
        // The old path pinned afterwards; that second write is exactly what
        // could fail and drop the task to Satellite, so it must be gone.
        XCTAssertEqual(mock.callCount("pinTask"), 0)
        XCTAssertEqual(mock.callCount("setTaskFocusTier"), 0)
        XCTAssertEqual(store.tierId(for: "t-qa-1"), "focus")
        XCTAssertEqual(store.transientNotice, "Added · Focus", "says WHERE it landed")
    }

    func testQuickAddFromAProjectHeaderFilesInThatProject() async throws {
        let mock = MockTaskTransport()
        mock.createdTaskId = "t-qa-2"
        let store = TasksStore(transport: mock)
        _ = try await store.quickAdd("draft the spec", seed: .project("marina"))

        let call = mock.calls.first { $0.name == "createTask" }
        XCTAssertEqual(call?.args[1], "marina")
        XCTAssertEqual(call?.args[5], "-", "a project header names no tier")
        XCTAssertEqual(store.tasks.first?.project, "marina")
    }

    /// The Inbox header's `+` must not invent a project named "Inbox".
    func testQuickAddFromTheInboxHeaderSendsNoProject() async throws {
        let mock = MockTaskTransport()
        let store = TasksStore(transport: mock)
        _ = try await store.quickAdd("no project", seed: .project("Inbox"))

        let call = mock.calls.first { $0.name == "createTask" }
        XCTAssertEqual(call?.args[1], "-", "Inbox is the EMPTY project, not a name")
    }

    /// A failed quick add leaves no placeholder AND no stale tier entry keyed to
    /// the placeholder id (which would otherwise linger in the map forever).
    func testQuickAddFailureClearsPlaceholderAndItsTier() async {
        let mock = MockTaskTransport()
        mock.errorsByEndpoint["createTask"] = APIError.server(
            status: 400, code: "bad_request", message: "unknown focus_tier",
            serverHash: nil, serverContent: nil
        )
        let store = TasksStore(transport: mock)

        do {
            _ = try await store.quickAdd("doomed", seed: .tier("ct_gone"))
            XCTFail("expected the create to throw")
        } catch {
            // expected
        }
        XCTAssertTrue(store.tasks.isEmpty, "the instant placeholder is withdrawn")
        XCTAssertTrue(store.taskTiers.isEmpty, "no tier entry orphaned to a dead placeholder id")
        XCTAssertNil(store.transientNotice)
    }

    // MARK: - Tier group headers get a seed for the tier they name

    private func makeSession(id: String, taskId: String, tier: String?) -> WalnutSession {
        WalnutSession(
            id: id, title: "s-\(id)", taskId: taskId, taskTitle: "t", project: nil,
            host: "", processStatus: "idle", model: nil, mode: nil,
            startedAt: "2026-08-27T00:00:00Z", lastActiveAt: "2026-08-27T00:00:00Z",
            messageCount: 1, cwd: nil, pinned: true, focusTier: tier, description: nil
        )
    }

    private func makePinnedTask(_ id: String) -> WalnutTask {
        WalnutTask(
            id: id, title: "task-\(id)", status: "todo", phase: "TODO",
            priority: "none", project: "", dueDate: nil,
            createdAt: "2026-08-27T00:00:00Z", updatedAt: "2026-08-27T00:00:00Z",
            completedAt: nil, starred: nil, pinned: true, tags: nil, summary: nil
        )
    }

    /// Every rendered band must map to a seed naming THAT tier — the create ring
    /// at the foot of Backlog cannot seed Focus. `BoardBand.tierId` IS the wire
    /// tier id, which is what makes the mapping a one-liner in the view.
    func testEveryRenderedBandSeedsItsOwnTier() {
        let tasks = ["t1", "t2", "t3", "t4"].map(makePinnedTask)
        let sessions = [
            makeSession(id: "s1", taskId: "t1", tier: "focus"),
            makeSession(id: "s2", taskId: "t2", tier: nil),       // satellite
            makeSession(id: "s3", taskId: "t3", tier: "backlog"),
            makeSession(id: "s4", taskId: "t4", tier: "wait"),
        ]
        let bands = BoardModel.bands(
            tasks: tasks, sessions: sessions,
            tierOf: ["t1": "focus", "t2": "satellite", "t3": "backlog", "t4": "wait"],
            tierOrder: ["focus": ["t1"], "satellite": ["t2"], "backlog": ["t3"], "wait": ["t4"]],
            customTiers: []
        )
        XCTAssertEqual(bands.map(\.tierId), ["focus", "satellite", "backlog", "wait"],
            "all four tiers render, in the desktop reading order")

        for band in bands {
            let seed = NewTaskSeed.tier(band.tierId)
            XCTAssertEqual(seed.pin, .tier(band.tierId))
            // The band's create ring sends the tier it names, verbatim, no project.
            XCTAssertEqual(seed.pin.wireFocusTier, band.tierId)
            XCTAssertEqual(seed.project, "")
        }
        // And the seeds are all distinct, so one open create row can't be
        // attributed to the wrong band.
        let ids = bands.map { NewTaskSeed.tier($0.tierId).id }
        XCTAssertEqual(Set(ids).count, ids.count)
    }

    /// Each built-in tier's id is one the server accepts — otherwise a band's
    /// create ring would 400 on every use.
    func testBandTierIdsAreValidWireTiers() {
        let builtins = TasksStore.builtinTiers.map(\.id)
        for tier in builtins {
            XCTAssertTrue(
                TaskPinChoice.tier(tier).isResolvable(builtinIds: builtins, customTierIds: []),
                "\(tier) must be a tier the create endpoint accepts"
            )
        }
    }

    /// The placeholder that appears BEFORE the POST resolves must already sit in
    /// the group the user typed in — that is the "instant" half of the flow.
    func testQuickAddPlaceholderIsPlacedBeforeTheServerAnswers() async throws {
        let mock = MockTaskTransport()
        let gate = CheckedContinuationGate()
        mock.gate = gate
        let store = TasksStore(transport: mock)

        let work = Task { try await store.quickAdd("mid-flight", seed: .tier("backlog")) }
        // Let the placeholder land while the create is suspended in the gate.
        try await Task.sleep(for: .milliseconds(60))
        let placeholder = store.tasks.first
        XCTAssertEqual(placeholder?.title, "mid-flight")
        XCTAssertEqual(placeholder?.pinned, true, "pinned from frame one")
        XCTAssertEqual(store.tierId(for: placeholder?.id ?? ""), "backlog",
            "the row renders under the header it was typed in, immediately")

        gate.open()
        _ = try await work.value
    }
}
