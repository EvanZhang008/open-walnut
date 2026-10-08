import XCTest
@testable import Walnut

/// Marking many letters at once (the Inbox's Select mode and Mark All Read):
/// every row and the badge flip in the tap's own turn, only letters that change
/// spend a request, at most `batchReadWidth` requests are on the wire, and each
/// letter keeps the single-tap guarantees (a failure rolls back that letter
/// alone, and its retry lands).
@MainActor
final class InboxBatchReadTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName = ""

    override func setUp() {
        super.setUp()
        suiteName = "InboxBatchReadTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private static let bridgeOffline = APIError.server(
        status: 503, code: "bridge_offline", message: "The primary is not connected", serverHash: nil, serverContent: nil
    )

    private func letter(_ id: String, read: Bool, minutesAgo: Double) -> Letter {
        let json: [String: Any] = [
            "id": id, "subject": "Subject of \(id)", "type": "info",
            "createdAt": Date().timeIntervalSince1970 * 1000 - minutesAgo * 60_000,
            "read": read, "pinned": false, "archived": false,
        ]
        let data = try! JSONSerialization.data(withJSONObject: json)
        return try! JSONDecoder().decode(Letter.self, from: data)
    }

    /// `count` letters, `unread` of them unread, newest first: l0, l1, ...
    private func letters(_ count: Int, unread: Int) -> [Letter] {
        (0..<count).map { letter("l\($0)", read: $0 >= unread, minutesAgo: Double($0 + 1)) }
    }

    private func store(_ transport: MockInboxTransport) -> InboxStore {
        let store = InboxStore(transport: transport, defaults: defaults)
        store.readRetryDelays = [.milliseconds(60), .milliseconds(60)]
        return store
    }

    private func waitUntil(_ what: String, timeout: Double = 3, _ condition: () -> Bool,
                           line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("timed out waiting for \(what)", line: line)
    }

    // MARK: - The store

    func testABatchFlipsEveryRowAndTheBadgeAtOnceAndSkipsLettersAlreadyRead() async {
        let transport = MockInboxTransport(letters(6, unread: 4))
        let inbox = store(transport)
        await inbox.refresh()
        XCTAssertEqual(inbox.unreadCount, 4)

        let changed = inbox.mark(ids: inbox.letters.map(\.id), read: true)
        // No await between the tap and these.
        XCTAssertEqual(changed, 4)
        XCTAssertEqual(inbox.unreadCount, 0)

        await waitUntil("the four writes") { transport.readWrites.count == 4 }
        XCTAssertEqual(Set(transport.readWrites.map(\.id)), ["l0", "l1", "l2", "l3"])
        XCTAssertTrue(transport.readWrites.allSatisfy(\.read))
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(transport.readWrites.count, 4, "a letter already read spent a request")

        // The server took them all: a refresh agrees with the screen.
        await inbox.refresh()
        XCTAssertEqual(inbox.unreadCount, 0)
    }

    func testABatchKeepsAtMostFourWritesOnTheWire() async {
        let transport = MockInboxTransport(letters(10, unread: 10))
        let gate = CheckedContinuationGate()
        transport.readGate = gate
        let inbox = store(transport)
        await inbox.refresh()

        XCTAssertEqual(inbox.mark(ids: inbox.letters.map(\.id), read: true), 10)
        XCTAssertEqual(inbox.unreadCount, 0)
        // Every started write is held at the gate, so the count is what is in flight.
        await waitUntil("the first wave") { transport.readWrites.count == InboxStore.batchReadWidth }
        try? await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(transport.readWrites.count, InboxStore.batchReadWidth, "more than the width went at once")

        gate.open()
        await waitUntil("every write") { transport.readWrites.count == 10 }
        await waitUntil("the answers") { inbox.readRetryIds.isEmpty && inbox.unreadCount == 0 }
        await inbox.refresh()
        XCTAssertEqual(inbox.unreadCount, 0)
    }

    func testOneFailureInABatchRollsBackOnlyThatLetterThenItsRetryLands() async {
        let transport = MockInboxTransport(letters(3, unread: 3))
        transport.scriptReads([nil, Self.bridgeOffline, nil])
        let inbox = store(transport)
        await inbox.refresh()

        inbox.mark(ids: ["l0", "l1", "l2"], read: true)
        XCTAssertEqual(inbox.unreadCount, 0)

        // The 503 comes back for one of them: that row alone shows the server again.
        await waitUntil("the one rollback") { inbox.readRetryIds.count == 1 }
        XCTAssertEqual(inbox.unreadCount, 1)
        let failed = try! XCTUnwrap(inbox.readRetryIds.first)
        XCTAssertEqual(inbox.letter(id: failed)?.isRead, false)

        // The retry lands it; nothing else is written twice.
        await waitUntil("the retry") { inbox.readRetryIds.isEmpty && inbox.unreadCount == 0 }
        XCTAssertEqual(transport.readWrites.count, 4)
        XCTAssertEqual(transport.readWrites.filter { $0.id == failed }.count, 2)
    }

    func testABatchCanMarkLettersUnread() async {
        let transport = MockInboxTransport(letters(4, unread: 0))
        let inbox = store(transport)
        await inbox.refresh()
        XCTAssertEqual(inbox.unreadCount, 0)

        XCTAssertEqual(inbox.mark(ids: ["l1", "l2", "l1"], read: false), 2, "a repeated id counts once")
        XCTAssertEqual(inbox.unreadCount, 2)
        await waitUntil("the writes") { transport.readWrites.count == 2 }
        XCTAssertTrue(transport.readWrites.allSatisfy { !$0.read })
        await inbox.refresh()
        XCTAssertEqual(inbox.unreadCount, 2)
    }

    func testABatchWithNothingToChangeSendsNothing() async {
        let transport = MockInboxTransport(letters(3, unread: 0))
        let inbox = store(transport)
        await inbox.refresh()
        XCTAssertEqual(inbox.mark(ids: ["l0", "l1", "l2"], read: true), 0)
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(transport.readWrites.isEmpty)
    }

    func testUnderUnreadABatchReadKeepsTheRowsListedUntilTheFilterChanges() async {
        let transport = MockInboxTransport(letters(5, unread: 3))
        let inbox = store(transport)
        inbox.filter = .unread
        await inbox.refresh()
        let now = InboxListing.nowMs()
        XCTAssertEqual(inbox.visibleRows(nowMs: now).map(\.id), ["l0", "l1", "l2"])

        inbox.mark(ids: ["l0", "l1", "l2"], read: true)
        XCTAssertEqual(inbox.unreadCount, 0)
        XCTAssertEqual(inbox.visibleRows(nowMs: now).map(\.id), ["l0", "l1", "l2"],
                       "the rows the human just marked vanished from under them")

        inbox.filter = .all
        inbox.filter = .unread
        XCTAssertEqual(inbox.visibleRows(nowMs: now).map(\.id), [])
    }

    // MARK: - What the bar acts on

    func testWithNothingSelectedTheBarMarksEveryUnreadRowOnScreen() {
        let rows = letters(5, unread: 3)
        let plan = InboxSelectionPlan(rows: rows, selection: [])
        XCTAssertTrue(plan.marksAll)
        XCTAssertEqual(plan.selectedCount, 0)
        XCTAssertEqual(plan.toRead, ["l0", "l1", "l2"])
        XCTAssertEqual(plan.toUnread, [])
    }

    func testASelectionSplitsIntoReadAndUnreadInListOrder() {
        let rows = letters(5, unread: 3)
        // l4 and l0 are picked out of order; "gone" is no longer a row.
        let plan = InboxSelectionPlan(rows: rows, selection: ["l4", "l0", "l3", "gone"])
        XCTAssertFalse(plan.marksAll)
        XCTAssertEqual(plan.selectedCount, 3)
        XCTAssertEqual(plan.toRead, ["l0"])
        XCTAssertEqual(plan.toUnread, ["l3", "l4"])
    }

    func testAllReadOnScreenLeavesMarkAllReadWithNothingToDo() {
        let plan = InboxSelectionPlan(rows: letters(3, unread: 0), selection: [])
        XCTAssertEqual(plan.toRead, [])
        XCTAssertEqual(InboxSelectionPlan(rows: [], selection: []).toRead, [])
    }
}
