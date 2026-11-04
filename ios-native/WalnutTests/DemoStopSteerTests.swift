import Foundation
import XCTest
@testable import Walnut

/// The demo server's Stop, queue and "Interrupt & send", through the app's own client.
/// The demo's `Rebuild the search index` session has a turn that runs until it is stopped
/// or steered, which is what these cases act on.
@MainActor
final class DemoStopSteerTests: XCTestCase {
    private var savedURL: URL?
    private var savedToken: String?
    private let api = WalnutAPI()
    private let session = "s-index"

    override func setUp() async throws {
        LifecycleHub.shared.teardownAll()
        savedURL = AppConfig.processServerURLOverride
        savedToken = AppConfig.processTokenOverride
        AppConfig.processServerURLOverride = DemoMode.baseURL
        AppConfig.processTokenOverride = DemoMode.token
        DemoServer.shared.latencyScale = 0
        DemoServer.shared.turnScale = 0
        DemoServer.shared.reset()
    }

    override func tearDown() async throws {
        DemoServer.shared.reset()
        DemoServer.shared.latencyScale = 1
        DemoServer.shared.turnScale = 1
        AppConfig.processServerURLOverride = savedURL
        AppConfig.processTokenOverride = savedToken
    }

    nonisolated override class func tearDown() {
        MainActor.assumeIsolated { LifecycleHub.shared.resumeAll() }
        super.tearDown()
    }

    private func settle() {
        let deadline = Date().addingTimeInterval(5)
        while DemoServer.shared.pendingStepCount > 0, Date() < deadline { usleep(5_000) }
        DemoServer.shared.turnQueue.sync {}
        DemoServer.shared.streams.drain()
    }

    private func status() async throws -> String {
        try await api.sessionDetail(id: session).session.processStatus ?? ""
    }

    private func transcript() async throws -> [SessionTranscript.Message] {
        try await api.sessionTranscript(id: session).messages
    }

    private func queue() async throws -> [SessionQueuedMessage] {
        try await api.sessionQueue(id: session)
    }

    private func send(_ text: String, id: String, interrupt: Bool = false) async throws {
        _ = try await api.sendSessionMessage(
            id: session, text: text, images: [], messageId: id, voice: false, interrupt: interrupt
        )
    }

    func testTheLongSessionRunsUntilItIsStopped() async throws {
        let running = try await status()
        XCTAssertEqual(running, "running")
        let stopped = try await api.interruptSession(id: session)
        XCTAssertTrue(stopped.wasRunning)
        let after = try await status()
        XCTAssertEqual(after, "idle", "a stop is not a terminate: the session stays")
        let kept = try await transcript().contains { $0.text.contains("38 of 120 shards") }
        XCTAssertTrue(kept, "what the turn had written is kept")
        let again = try await api.interruptSession(id: session)
        XCTAssertFalse(again.wasRunning, "nothing runs now")
    }

    func testAMessageSentMidTurnWaitsInTheQueueUnderItsOwnId() async throws {
        try await send("Skip the slow shards", id: "qm-demo-steer-1")
        let rows = try await queue()
        XCTAssertEqual(rows.map(\.id), ["qm-demo-steer-1"])
        XCTAssertEqual(rows.first?.status, "pending")
        XCTAssertEqual(rows.first?.message, "Skip the slow shards")
        let ran = try await transcript().contains { $0.role == "user" && $0.text == "Skip the slow shards" }
        XCTAssertFalse(ran, "it waits for the turn to end")
    }

    func testAQueuedMessageCanBeEditedAndWithdrawn() async throws {
        try await send("first words", id: "qm-demo-steer-2")
        try await api.editQueuedMessage(sessionId: session, messageId: "qm-demo-steer-2", text: "better words")
        let edited = try await queue()
        XCTAssertEqual(edited.first?.message, "better words")
        try await api.deleteQueuedMessage(sessionId: session, messageId: "qm-demo-steer-2")
        let gone = try await queue()
        XCTAssertTrue(gone.isEmpty)
        do {
            try await api.deleteQueuedMessage(sessionId: session, messageId: "qm-demo-steer-2")
            XCTFail("a second withdraw has nothing to withdraw")
        } catch let error as APIError {
            XCTAssertEqual(error.code, "not_found")
        }
    }

    func testAStopSetsAsideWhatWasQueuedAndStartsNoTurnForIt() async throws {
        try await send("queued behind the turn", id: "qm-demo-steer-3")
        _ = try await api.interruptSession(id: session)
        settle()
        let rows = try await queue()
        XCTAssertEqual(rows.first?.status, "parked")
        let ran = try await transcript().contains { $0.role == "user" && $0.text == "queued behind the turn" }
        XCTAssertFalse(ran, "a Stop does not start the next turn by itself")
        // The words of a message a Stop set aside are still its owner's to change.
        try await api.editQueuedMessage(sessionId: session, messageId: "qm-demo-steer-3", text: "changed")
        let edited = try await queue()
        XCTAssertEqual(edited.first?.message, "changed")
        XCTAssertEqual(edited.first?.status, "parked")
        try await api.deleteQueuedMessage(sessionId: session, messageId: "qm-demo-steer-3")
    }

    func testInterruptAndSendEndsTheTurnAndAnswersTheNewWords() async throws {
        try await send("Stop and summarise", id: "qm-demo-steer-4", interrupt: true)
        settle()
        let rows = try await transcript()
        XCTAssertTrue(rows.contains { $0.text.contains("38 of 120 shards") }, "the stopped turn is kept")
        XCTAssertTrue(rows.contains { $0.role == "user" && $0.text == "Stop and summarise" })
        XCTAssertTrue(rows.contains { $0.role == "assistant" && $0.kind == nil && $0.text.contains("get oriented") })
        let left = try await queue()
        XCTAssertTrue(left.isEmpty)
        let after = try await status()
        XCTAssertEqual(after, "idle")
    }

    func testSendNowWithInterruptRunsTheQueuedMessageInAFreshTurn() async throws {
        try await send("Do this first", id: "qm-demo-steer-5")
        try await api.sendQueuedNow(messageId: "qm-demo-steer-5", interrupt: true)
        settle()
        let rows = try await transcript()
        XCTAssertTrue(rows.contains { $0.role == "user" && $0.text == "Do this first" })
        let left = try await queue()
        XCTAssertTrue(left.isEmpty)
    }

    func testSendNowWithoutInterruptLeavesItWaitingForTheTurn() async throws {
        try await send("Wait your turn", id: "qm-demo-steer-6")
        try await api.sendQueuedNow(messageId: "qm-demo-steer-6", interrupt: false)
        let rows = try await queue()
        XCTAssertEqual(rows.map(\.id), ["qm-demo-steer-6"])
    }

    func testSendingTwoHeldMessagesAgainLeavesNeitherHeldBack() async throws {
        try await send("held one", id: "qm-demo-steer-7")
        try await send("held two", id: "qm-demo-steer-8")
        _ = try await api.interruptSession(id: session)
        settle()
        let held = try await queue()
        XCTAssertEqual(held.map(\.status), ["parked", "parked"])
        // The first starts a turn; the second, sent while that turn runs, is back in line behind it.
        try await api.sendQueuedNow(messageId: "qm-demo-steer-7", interrupt: false)
        try await api.sendQueuedNow(messageId: "qm-demo-steer-8", interrupt: false)
        // Either the first turn is still running (the second waits in line, no longer held back) or it
        // already ended (the second went in too): never left "Not sent".
        let now = try await queue()
        XCTAssertTrue(now.isEmpty || now.map(\.status) == ["pending"], "no longer held back: \(now.map(\.status))")
        settle()
        let rows = try await transcript()
        XCTAssertTrue(rows.contains { $0.role == "user" && $0.text == "held one" })
        XCTAssertTrue(rows.contains { $0.role == "user" && $0.text == "held two" }, "the second one went in too")
        let left = try await queue()
        XCTAssertTrue(left.isEmpty)
    }

    func testSendNowOfAMessageThatIsNotQueuedIsAConflict() async throws {
        do {
            try await api.sendQueuedNow(messageId: "qm-demo-nothing", interrupt: true)
            XCTFail("nothing to send")
        } catch let error as APIError {
            XCTAssertEqual(error.code, "not_queued")
        }
    }
}
