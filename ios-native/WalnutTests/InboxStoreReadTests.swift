import UIKit
import XCTest
@testable import Walnut

/// Scripted `InboxTransport`: a list the test edits, read writes recorded in
/// order, a scripted outcome per write, and a gate that holds a write open so a
/// test can act while it is genuinely in flight.
final class MockInboxTransport: InboxTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var serverLetters: [Letter]
    private var readOutcomes: [Error?] = []
    private var writes: [(id: String, read: Bool)] = []
    var readGate: CheckedContinuationGate?

    init(_ letters: [Letter]) { serverLetters = letters }

    /// The server's list, as the next GET answers it.
    func setServer(_ letters: [Letter]) { lock.withLock { serverLetters = letters } }

    /// Outcomes for the next read writes, in order: nil = accepted, else thrown.
    /// Past the end every write is accepted.
    func scriptReads(_ outcomes: [Error?]) { lock.withLock { readOutcomes += outcomes } }

    var readWrites: [(id: String, read: Bool)] { lock.withLock { writes } }

    private static func notFound() -> APIError {
        APIError.server(status: 404, code: "not_found", message: "no letter", serverHash: nil, serverContent: nil)
    }

    func letters(archived: Bool) async throws -> LetterListResponse {
        let rows = lock.withLock { serverLetters.filter { $0.isArchived == archived } }
        return LetterListResponse(letters: rows, unreadCount: rows.filter { !$0.isRead }.count)
    }

    func letter(id: String) async throws -> Letter {
        guard let row = lock.withLock({ serverLetters.first { $0.id == id } }) else { throw Self.notFound() }
        return row
    }

    func setLetterRead(id: String, read: Bool) async throws -> Letter {
        let (outcome, gate): (Error?, CheckedContinuationGate?) = lock.withLock {
            writes.append((id, read))
            return (readOutcomes.isEmpty ? nil : readOutcomes.removeFirst(), readGate)
        }
        await gate?.wait()
        if let outcome { throw outcome }
        let updated: Letter? = lock.withLock {
            guard let idx = serverLetters.firstIndex(where: { $0.id == id }) else { return nil }
            if serverLetters[idx].isRead != read {
                serverLetters[idx].read = read
                serverLetters[idx].readAt = Date().timeIntervalSince1970 * 1000
            }
            return serverLetters[idx]
        }
        guard let updated else { throw Self.notFound() }
        return updated
    }

    func setLetterPinned(id: String, pinned: Bool) async throws -> Letter { try await letter(id: id) }
    func setLetterArchived(id: String, archived: Bool) async throws -> Letter { try await letter(id: id) }
    func answerLetter(id: String, actionId: String, freeText: String?) async throws -> LetterActionResult {
        throw APIError.badResponse
    }
    func replyToLetter(id: String, text: String) async throws -> LetterActionResult { throw APIError.badResponse }
}

/// The Inbox read machine: opening marks read at once, a failure never leaves a
/// read on screen that the server did not take, a failure that can pass is
/// retried until it lands, and the filter keeps its promises across all of it.
///
/// The phone usually reaches the Mac through the cloud relay, which answers 503
/// `bridge_offline` while the Mac is away: that is the failure staged here.
@MainActor
final class InboxStoreReadTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName = ""

    override func setUp() {
        super.setUp()
        suiteName = "InboxStoreReadTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private static let bridgeOffline = APIError.server(
        status: 503, code: "bridge_offline", message: "The primary is not connected", serverHash: nil, serverContent: nil
    )

    private func letter(
        _ id: String, read: Bool, type: String = "info", minutesAgo: Double, pinned: Bool = false,
        readAt: Double? = nil
    ) -> Letter {
        var json: [String: Any] = [
            "id": id, "subject": "Subject of \(id)", "type": type,
            "createdAt": Date().timeIntervalSince1970 * 1000 - minutesAgo * 60_000,
            "read": read, "pinned": pinned, "archived": false,
        ]
        if let readAt { json["readAt"] = readAt }
        if type == "action_required" { json["actions"] = [["id": "yes", "label": "Yes"]] }
        let data = try! JSONSerialization.data(withJSONObject: json)
        return try! JSONDecoder().decode(Letter.self, from: data)
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

    // MARK: - Opening marks read

    func testOpeningFlipsTheRowAndTheBadgeInTheSameTurnThenWritesOnce() async {
        let transport = MockInboxTransport([
            letter("a", read: false, minutesAgo: 1), letter("b", read: false, minutesAgo: 2),
            letter("c", read: true, minutesAgo: 3),
        ])
        let inbox = store(transport)
        await inbox.refresh()
        XCTAssertEqual(inbox.unreadCount, 2)

        inbox.markReadOnOpen(id: "a")
        // No await between the tap and these: the badge moves with the finger.
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, true)
        XCTAssertEqual(inbox.unreadCount, 1)
        XCTAssertNotNil(inbox.letter(id: "a")?.readAt, "the optimistic flip stamps readAt, as the console does")

        await waitUntil("the write") { transport.readWrites.count == 1 }
        XCTAssertEqual(transport.readWrites.first?.id, "a")
        XCTAssertEqual(transport.readWrites.first?.read, true)

        // Re-opening a read letter spends nothing.
        inbox.markReadOnOpen(id: "a")
        inbox.markReadOnOpen(id: "c")
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(transport.readWrites.count, 1, "an already-read letter wrote again")
    }

    // MARK: - Failure, rollback, retry

    func testARelayFailureRollsBackThenTheRetryLandsTheRead() async {
        let transport = MockInboxTransport([letter("a", read: false, minutesAgo: 1)])
        transport.scriptReads([Self.bridgeOffline])
        let inbox = store(transport)
        await inbox.refresh()

        inbox.markReadOnOpen(id: "a")
        XCTAssertEqual(inbox.unreadCount, 0)
        // The 503 comes back: the row shows the server's answer again and says why.
        await waitUntil("the rollback") { inbox.readRetryIds.contains("a") }
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, false, "a read the server did not take is on screen")
        XCTAssertEqual(inbox.unreadCount, 1)
        XCTAssertNil(inbox.errorMessage, "a failure that can pass is a notice, not an error banner")

        // The ladder's first rung sends it again, and this time the relay takes it.
        await waitUntil("the retry to land") { inbox.letter(id: "a")?.isRead == true }
        XCTAssertEqual(transport.readWrites.count, 2)
        XCTAssertTrue(inbox.readRetryIds.isEmpty)
        XCTAssertEqual(inbox.unreadCount, 0)
    }

    func testPastTheLadderTheReadWaitsForTheNextRefreshAndIsNeverLost() async {
        let transport = MockInboxTransport([letter("a", read: false, minutesAgo: 1)])
        // First attempt plus both rungs fail.
        transport.scriptReads([Self.bridgeOffline, Self.bridgeOffline, Self.bridgeOffline])
        let inbox = store(transport)
        await inbox.refresh()

        inbox.markReadOnOpen(id: "a")
        await waitUntil("three failed attempts") { transport.readWrites.count == 3 && inbox.readRetryIds.contains("a") }
        try? await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(transport.readWrites.count, 3, "the ladder kept going past its last rung")
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, false)
        XCTAssertTrue(inbox.readRetryIds.contains("a"), "the waiting write was forgotten")

        // The Mac is back: the next refresh (foreground, pull) sends it.
        await inbox.refresh()
        await waitUntil("the refresh's retry to land") { inbox.letter(id: "a")?.isRead == true }
        XCTAssertEqual(transport.readWrites.count, 4)
        XCTAssertTrue(inbox.readRetryIds.isEmpty)
    }

    func testARealRefusalIsDroppedAndReportedNotRetried() async {
        let transport = MockInboxTransport([letter("a", read: false, minutesAgo: 1)])
        transport.scriptReads([APIError.server(
            status: 404, code: "not_found", message: "Letter not found", serverHash: nil, serverContent: nil
        )])
        let inbox = store(transport)
        await inbox.refresh()

        inbox.markReadOnOpen(id: "a")
        await waitUntil("the refusal") { inbox.errorMessage != nil }
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, false)
        XCTAssertTrue(inbox.readRetryIds.isEmpty)
        try? await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(transport.readWrites.count, 1, "a 404 was retried")
    }

    func testFailureClassesThatCanPass() {
        XCTAssertTrue(InboxStore.readFailureCanPass(Self.bridgeOffline))
        XCTAssertTrue(InboxStore.readFailureCanPass(APIError.network(underlying: URLError(.timedOut))))
        XCTAssertTrue(InboxStore.readFailureCanPass(APIError.rateLimited))
        XCTAssertTrue(InboxStore.readFailureCanPass(APIError.server(
            status: 408, code: "timeout", message: "", serverHash: nil, serverContent: nil)))
        XCTAssertFalse(InboxStore.readFailureCanPass(APIError.server(
            status: 400, code: "bad_request", message: "", serverHash: nil, serverContent: nil)))
        XCTAssertFalse(InboxStore.readFailureCanPass(APIError.unauthorized))
    }

    // MARK: - Races

    /// A list read that lands while the write is on the wire describes the server
    /// BEFORE the write. The row keeps the tap until the write answers.
    func testARefreshDuringAnInFlightWriteKeepsTheTap() async {
        let transport = MockInboxTransport([letter("a", read: false, minutesAgo: 1)])
        let gate = CheckedContinuationGate()
        transport.readGate = gate
        let inbox = store(transport)
        await inbox.refresh()

        inbox.markReadOnOpen(id: "a")
        await waitUntil("the write to be in flight") { transport.readWrites.count == 1 }
        await inbox.refresh()
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, true, "a stale list undid the tap mid-write")
        XCTAssertEqual(inbox.unreadCount, 0)

        gate.open()
        try? await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, true)
        XCTAssertEqual(transport.readWrites.count, 1)
        XCTAssertTrue(inbox.readRetryIds.isEmpty)
    }

    /// The same race ending in failure rolls back to what the refresh said, not to
    /// what the row said before the tap.
    func testAFailedWriteAfterARefreshRollsBackToTheRefreshedServerValue() async {
        let transport = MockInboxTransport([letter("a", read: false, minutesAgo: 1)])
        let gate = CheckedContinuationGate()
        transport.readGate = gate
        transport.scriptReads([APIError.server(
            status: 400, code: "bad_request", message: "refused", serverHash: nil, serverContent: nil
        )])
        let inbox = store(transport)
        await inbox.refresh()

        inbox.markReadOnOpen(id: "a")
        await waitUntil("the write to be in flight") { transport.readWrites.count == 1 }
        // Someone read it on the web meanwhile: the server now says read.
        transport.setServer([letter("a", read: true, minutesAgo: 1, readAt: 42)])
        await inbox.refresh()
        gate.open()
        await waitUntil("the refusal") { inbox.errorMessage != nil }
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, true, "rolled back past the server's newer answer")
        XCTAssertEqual(inbox.letter(id: "a")?.readAt, 42)
    }

    // MARK: - Filters

    func testReadingUnderUnreadKeepsTheRowUntilTheFilterChanges() async {
        let transport = MockInboxTransport([
            letter("a", read: false, minutesAgo: 1), letter("b", read: true, minutesAgo: 2),
        ])
        let inbox = store(transport)
        await inbox.refresh()
        inbox.filter = .unread
        XCTAssertEqual(inbox.visibleRows(nowMs: InboxListing.nowMs()).map(\.id), ["a"])

        inbox.markReadOnOpen(id: "a")
        XCTAssertEqual(inbox.visibleRows(nowMs: InboxListing.nowMs()).map(\.id), ["a"],
                       "the row just opened vanished from under the reader")
        XCTAssertEqual(inbox.count(for: .unread), 0, "the count drops at once even though the row stays")

        inbox.filter = .all
        inbox.filter = .unread
        XCTAssertEqual(inbox.visibleRows(nowMs: InboxListing.nowMs()).map(\.id), [], "the keep set outlived its filter")
    }

    func testLeavingTheTabForgetsKeptRows() async {
        let transport = MockInboxTransport([letter("a", read: false, minutesAgo: 1)])
        let inbox = store(transport)
        await inbox.refresh()
        inbox.filter = .unread
        inbox.markReadOnOpen(id: "a")
        XCTAssertEqual(inbox.visibleRows(nowMs: InboxListing.nowMs()).count, 1)
        inbox.forgetKeptRows()
        XCTAssertEqual(inbox.visibleRows(nowMs: InboxListing.nowMs()).count, 0)
        XCTAssertEqual(inbox.filter, .unread, "leaving the tab must not change the chosen filter")
    }

    func testANewLetterArrivingWhileFilteredLandsAtTheTopOfThatFilter() async {
        let transport = MockInboxTransport([
            letter("pinned", read: false, minutesAgo: 90, pinned: true),
            letter("a", read: false, minutesAgo: 10),
            letter("old", read: true, minutesAgo: 20),
        ])
        let inbox = store(transport)
        await inbox.refresh()
        inbox.filter = .unread
        inbox.markReadOnOpen(id: "a")
        await waitUntil("the write") { transport.readWrites.count == 1 }

        var server = [
            letter("pinned", read: false, minutesAgo: 90, pinned: true),
            letter("a", read: true, minutesAgo: 10),
            letter("old", read: true, minutesAgo: 20),
        ]
        server.append(letter("new", read: false, type: "action_required", minutesAgo: 0))
        transport.setServer(server)
        await inbox.refresh()
        XCTAssertEqual(
            inbox.visibleRows(nowMs: InboxListing.nowMs()).map(\.id), ["pinned", "new", "a"],
            "pinned keeps its place, the arrival is next, and the row read under the filter is still kept"
        )
        XCTAssertEqual(inbox.unreadCount, 2)
        XCTAssertEqual(inbox.unseenDecisionCount, 1)
    }

    /// Reading a decision takes it off the count at once; the row stays under
    /// Action needed for the console's five-minute grace, then leaves.
    func testAReadDecisionLeavesTheCountAtOnceAndTheListAfterTheGrace() async {
        let transport = MockInboxTransport([letter("d", read: false, type: "action_required", minutesAgo: 1)])
        let inbox = store(transport)
        await inbox.refresh()
        inbox.filter = .actionNeeded
        XCTAssertEqual(inbox.count(for: .actionNeeded), 1)

        inbox.markReadOnOpen(id: "d")
        let now = InboxListing.nowMs()
        XCTAssertEqual(inbox.count(for: .actionNeeded), 0)
        XCTAssertEqual(inbox.visibleRows(nowMs: now).map(\.id), ["d"])
        XCTAssertEqual(inbox.visibleRows(nowMs: now + Letter.decisionSeenGraceMs + 1_000).map(\.id), [])
        let expiry = InboxListing.nextGraceExpiry(inbox.letters, nowMs: now)
        XCTAssertNotNil(expiry, "no timer armed for the grace window")
    }

    func testTheChosenFilterSurvivesARelaunch() {
        let transport = MockInboxTransport([])
        let first = store(transport)
        XCTAssertEqual(first.filter, .all, "a fresh install starts on All")
        first.filter = .review
        let relaunched = InboxStore(transport: transport, defaults: defaults)
        XCTAssertEqual(relaunched.filter, .review)
        defaults.set("starred", forKey: InboxFilter.storageKey)
        XCTAssertEqual(InboxStore(transport: transport, defaults: defaults).filter, .all)
    }

    func testTheRetryNoticeCopy() {
        XCTAssertEqual(InboxReadRetryNotice.text(count: 1), "1 letter could not be marked read yet. Walnut will try again.")
        XCTAssertEqual(InboxReadRetryNotice.text(count: 3), "3 letters could not be marked read yet. Walnut will try again.")
        for filter in InboxFilter.allCases {
            let copy = InboxEmptyCopy(filter: filter)
            XCTAssertFalse(copy.title.isEmpty)
            XCTAssertFalse((copy.title + copy.detail).contains("\u{2014}"), "no em dashes in UI copy")
            XCTAssertNotNil(UIImage(systemName: copy.symbol), "\(copy.symbol) is not an SF Symbol")
        }
    }
}
