import Foundation
import XCTest
@testable import Walnut

/// Scripted `ChatMessagesTransport`: answers per conversation, and can hold ONE
/// conversation's fetch open while the test switches to another. That ordering is
/// the whole bug, and it is not reproducible through a live URLSession.
final class MockChatMessagesTransport: ChatMessagesTransport, @unchecked Sendable {
    private let lock = NSLock()

    /// Canonical history per conversation id.
    var rows: [String: [ChatMessage]] = [:]
    /// Conversations whose fetch suspends until the test opens their gate.
    var gates: [String: CheckedContinuationGate] = [:]

    private var requested: [String] = []
    private var answered: [String] = []

    /// Conversations whose fetch has been ASKED for (in order).
    var requestedConversations: [String] {
        lock.lock(); defer { lock.unlock() }
        return requested
    }

    /// Conversations whose fetch has RETURNED — the moment the store is about to
    /// decide whether to apply it.
    var answeredConversations: [String] {
        lock.lock(); defer { lock.unlock() }
        return answered
    }

    func messages(
        conversationID: String, agentID: String, limit: Int, before: String?
    ) async throws -> [ChatMessage] {
        lock.lock(); requested.append(conversationID); lock.unlock()
        if let gate = gates[conversationID] { await gate.wait() }
        lock.lock(); answered.append(conversationID); lock.unlock()
        return rows[conversationID] ?? []
    }
}

/// Switching conversations must never leave one conversation's messages rendered
/// under another conversation's title (2026-09-07 drawer UI gate: reproduced
/// twice, stable for 9s+, so not a flash — nothing refetches to correct it).
///
/// Two independent mechanisms are pinned here, because either one alone lets the
/// mismatch through:
///   1. APPLY-TIME scoping — a fetch captures the conversation it was started for
///      and is dropped if that is no longer the conversation on screen when the
///      answer lands (`stillViewing`);
///   2. OWNED local rows — `carryLocalRows` keeps any local row a canonical fetch
///      does not contain, which is right for a lagging replica and wrong across a
///      switch, so every local row the store invents carries the conversation it
///      belongs to (`localRowConversation`).
///
/// Offline by construction: message reads go through the mock, and the test
/// process is pointed at the discard port (`WalnutTestsPrincipal`), so the send
/// path's POST fails immediately instead of reaching any server.
@MainActor
final class ChatConversationSwitchTests: XCTestCase {

    private let alpha = "conv-alpha"
    private let beta = "conv-beta"

    /// `select` persists the active conversation, and this bundle is HOSTED — the
    /// container is the app's. Whatever the app had is restored on the way out.
    private static let activeConversationKey = "walnut.activeConversation.general"
    private var savedActiveConversation: String?

    override func setUp() async throws {
        savedActiveConversation = UserDefaults.standard.string(forKey: Self.activeConversationKey)
        clearMessageCaches()
    }

    override func tearDown() async throws {
        if let savedActiveConversation {
            UserDefaults.standard.set(savedActiveConversation, forKey: Self.activeConversationKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.activeConversationKey)
        }
        clearMessageCaches()
    }

    private func clearMessageCaches() {
        DiskCache.remove(key: "messages-\(alpha)")
        DiskCache.remove(key: "messages-\(beta)")
    }

    // MARK: - Fixtures (neutral, boring content on purpose)

    private let fixtureNow = ISO8601DateFormatter().date(from: "2026-09-07T09:38:00Z")!

    /// Real-clock stamp for echoes handed to the STORE: `loadMessages` merges with
    /// the real `Date()`, so a fixed fixture timestamp would let the echo TTL
    /// backstop decide the outcome instead of the rule under test.
    private var nowStamp: String { ISO8601DateFormatter().string(from: Date()) }

    private func msg(
        _ id: String, _ role: String, _ text: String,
        kind: ChatMessage.Kind? = nil,
        createdAt: String = "2026-09-07T09:37:00Z",
        pending: Bool? = nil, failed: Bool? = nil
    ) -> ChatMessage {
        var m = ChatMessage(id: id, role: role, text: text, createdAt: createdAt, kind: kind)
        m.pending = pending
        m.failed = failed
        return m
    }

    private var alphaHistory: [ChatMessage] {
        [
            msg("a1", "user", "What is left on the grocery list?"),
            msg("a2", "assistant", "Rice, olive oil and two lemons."),
        ]
    }

    private var betaHistory: [ChatMessage] {
        [
            msg("b1", "user", "When is the bike service booked?"),
            msg("b2", "assistant", "Thursday at four."),
        ]
    }

    /// The send-path tests below really do POST. This bundle is HOSTED, so it
    /// inherits the device's pairing, and the only reason a POST here is harmless
    /// is that the process is pinned to a dead loopback port
    /// (`TestProcessNetworkBlackhole`, the discard port 9). Assert that rather
    /// than assume it: if the pin ever stops running, this must fail loudly
    /// instead of firing a real message at whatever server the device is paired
    /// to (a Walnut console on `localhost:3456` is loopback too, so "is it
    /// loopback" is not the question).
    private func assertProcessIsBlackholed() -> Bool {
        let url = AppConfig.serverURL
        guard url?.port == 9 else {
            XCTFail("refusing to exercise the send path: this process is not blackholed "
                + "(serverURL = \(url?.absoluteString ?? "nil"))")
            return false
        }
        return true
    }

    private func poll(
        _ label: String, until condition: @MainActor () -> Bool
    ) async {
        for _ in 0..<400 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for \(label)")
    }

    // MARK: - 1. A fetch that lost the race is dropped, not painted

    /// The reported shape: conversation A's fetch resolves AFTER the drawer
    /// switched to B. It must be discarded — B's own fetch is the only authority
    /// for what is rendered under B's title.
    func testFetchForThePreviousConversationIsDroppedAfterSwitch() async {
        let mock = MockChatMessagesTransport()
        let alphaGate = CheckedContinuationGate()
        mock.gates[alpha] = alphaGate
        mock.rows[alpha] = alphaHistory
        mock.rows[beta] = betaHistory
        let store = ChatStore(transport: mock)

        // Open A: its fetch reaches the gate and stays there.
        store.select(alpha)
        await poll("A's fetch to be in flight") { mock.requestedConversations.contains(self.alpha) }
        XCTAssertTrue(mock.answeredConversations.isEmpty, "A must still be waiting at the gate")

        // Tap B in the drawer while A is still in flight.
        store.select(beta)
        await poll("B's rows to land") { store.messages.map(\.id) == ["b1", "b2"] }
        XCTAssertEqual(store.activeID, beta)

        // NOW let A answer — after the switch.
        alphaGate.open()
        await poll("A's fetch to resolve") { mock.answeredConversations.contains(self.alpha) }
        // Give any (wrongly) queued apply a chance to run before judging.
        for _ in 0..<20 { await Task.yield() }

        XCTAssertEqual(store.messages.map(\.id), ["b1", "b2"],
            "a fetch that resolved after the switch must never replace the conversation on screen")
        XCTAssertFalse(store.messages.contains { $0.id == "a1" || $0.id == "a2" },
            "the previous conversation's rows must not appear under the new conversation's title")
        XCTAssertEqual(store.activeID, beta, "title and body must describe the same conversation")

        store.closeStream()
    }

    /// The same guard, one step earlier: a stale fetch must not even flip the
    /// store-wide `loadingMessages` flag, which redacts whatever IS on screen.
    func testStaleLoadDoesNotRedactTheConversationOnScreen() async {
        let mock = MockChatMessagesTransport()
        mock.rows[beta] = betaHistory
        let store = ChatStore(transport: mock)
        store.activeID = beta

        await store.loadMessages(alpha)
        XCTAssertFalse(store.loadingMessages, "a load for a conversation nobody is viewing must not redact")
        XCTAssertTrue(store.messages.isEmpty)
        XCTAssertFalse(mock.requestedConversations.contains(alpha),
            "and it should not even be requested")
    }

    // MARK: - 2. carryLocalRows is conversation-scoped

    /// A local row belonging to conversation A is never carried into a merge for
    /// conversation B — including a `pending` one, which every other rule in
    /// `carryLocalRows` keeps unconditionally.
    func testCarryLocalRowsNeverCarriesAnotherConversationsRow() {
        let foreignEcho = msg("local-1", "user", "Move the bike service to Friday", pending: true)
        let foreignReply = msg("turn-2", "assistant", "Moved it to Friday.")
        let current = betaHistory + [foreignEcho, foreignReply]

        let out = ChatStore.carryLocalRows(
            current: current, fetched: betaHistory,
            conversationID: beta, owners: ["local-1": alpha, "turn-2": alpha],
            now: fixtureNow
        )
        XCTAssertTrue(out.isEmpty,
            "rows owned by another conversation must be dropped, pending included: \(out.map(\.id))")

        // Control — the SAME rows owned by THIS conversation are still kept, which
        // is the lagging-replica case carryLocalRows exists for.
        let kept = ChatStore.carryLocalRows(
            current: current, fetched: betaHistory,
            conversationID: beta, owners: ["local-1": beta, "turn-2": beta],
            now: fixtureNow
        )
        XCTAssertEqual(kept.map(\.id), ["local-1", "turn-2"],
            "this conversation's own echoes must survive a fetch that has not caught up")
    }

    /// A row the store never tagged (canonical rows, and any caller with no
    /// conversation scope) is treated as this conversation's — the old behaviour,
    /// unchanged.
    func testUntaggedRowsKeepTheOldBehaviour() {
        let echo = msg("local-1", "user", "Add lemons to the list")
        let out = ChatStore.carryLocalRows(
            current: betaHistory + [echo], fetched: betaHistory,
            conversationID: beta, owners: [:], now: fixtureNow
        )
        XCTAssertEqual(out.map(\.id), ["local-1"])
    }

    // MARK: - 3. Regression guard: same conversation still keeps its echoes

    /// The behaviour this fix must NOT change: refetching the conversation you are
    /// looking at keeps its own optimistic rows.
    func testSameConversationOptimisticRowsSurviveARefetch() async {
        let mock = MockChatMessagesTransport()
        mock.rows[beta] = betaHistory // the fetch has not caught up with the echo
        let store = ChatStore(transport: mock)
        store.activeID = beta
        let echo = msg("local-9", "user", "Book the bike service", createdAt: nowStamp, pending: true)
        store.messages = betaHistory + [echo]

        await store.loadMessages(beta)

        XCTAssertEqual(store.messages.map(\.id), ["b1", "b2", "local-9"],
            "a refetch of the SAME conversation must keep its optimistic bubble")
        XCTAssertEqual(store.messages.last?.pending, true, "and keep it pending")
    }

    /// Once the fetch does carry the canonical copy, the echo retires as before —
    /// the owner check must not turn echoes into permanent duplicates.
    func testConvergedFetchStillRetiresThisConversationsEcho() async {
        let mock = MockChatMessagesTransport()
        let converged = betaHistory + [msg("b3", "user", "Book the bike service")]
        mock.rows[beta] = converged
        let store = ChatStore(transport: mock)
        store.activeID = beta
        store.messages = betaHistory + [msg("local-9", "user", "Book the bike service", createdAt: nowStamp)]

        await store.loadMessages(beta)

        XCTAssertEqual(store.messages.map(\.id), ["b1", "b2", "b3"],
            "the canonical row must absorb the echo, not sit beside it")
        XCTAssertTrue(store.localRowConversation.isEmpty,
            "a retired echo must leave no owner entry behind")
    }

    // MARK: - 4. The store really does tag the rows it invents

    /// End to end over the send path: the optimistic bubble is tagged with the
    /// conversation it was sent in, and that tag is what stops it from ever being
    /// merged into another conversation's list.
    func testOptimisticRowIsTaggedWithTheConversationItWasSentIn() async {
        guard assertProcessIsBlackholed() else { return }
        let mock = MockChatMessagesTransport()
        let store = ChatStore(transport: mock)
        store.activeID = beta

        // The POST goes to the blackholed loopback port: refused immediately, so
        // the bubble settles as a failed one and the text is kept.
        let accepted = await store.send("Pick the bike up on Thursday")
        XCTAssertFalse(accepted, "an unreachable server cannot accept a turn")

        guard let row = store.messages.last else {
            return XCTFail("the send must leave its text on screen")
        }
        XCTAssertTrue(row.id.hasPrefix("local-"), "expected the optimistic bubble, got \(row.id)")
        XCTAssertEqual(store.localRowConversation[row.id], beta,
            "the optimistic bubble must record the conversation it belongs to")

        // The join that matters: this tagged row can never ride into another
        // conversation's merge, whatever that conversation's fetch looks like.
        let carried = ChatStore.carryLocalRows(
            current: store.messages, fetched: alphaHistory,
            conversationID: alpha, owners: store.localRowConversation, now: fixtureNow
        )
        XCTAssertTrue(carried.isEmpty,
            "a row tagged for one conversation must not be carried into another: \(carried.map(\.id))")

        store.closeStream()
    }

    /// Selecting another conversation drops the previous one's owner entries: a
    /// tag whose row is gone would be a lie about whatever comes next.
    func testSelectingAnotherConversationClearsTheOwnerMap() async {
        guard assertProcessIsBlackholed() else { return }
        let mock = MockChatMessagesTransport()
        mock.rows[beta] = betaHistory
        let store = ChatStore(transport: mock)
        store.activeID = beta
        _ = await store.send("Pick the bike up on Thursday")
        XCTAssertFalse(store.localRowConversation.isEmpty, "precondition: the echo was tagged")

        store.select(alpha)
        XCTAssertTrue(store.localRowConversation.isEmpty)
        XCTAssertTrue(store.messages.isEmpty)

        store.closeStream()
    }
}
