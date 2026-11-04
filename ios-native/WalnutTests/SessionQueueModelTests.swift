import XCTest
@testable import Walnut

/// The queue strip's model: what it reads, how often, and what each write does to the
/// rows and to the bubbles the page keeps for them.
@MainActor
final class SessionQueueModelTests: XCTestCase {
    final class Transport: SessionQueueTransport, @unchecked Sendable {
        private let lock = NSLock()
        var rows: [SessionQueuedMessage] = []
        var readError: Error?
        var writeError: Error?
        var readGate: CheckedContinuationGate?
        private(set) var reads = 0
        private(set) var deleted: [String] = []
        private(set) var edited: [(String, String)] = []
        private(set) var sentNow: [(String, Bool)] = []

        func sessionQueue(id: String) async throws -> [SessionQueuedMessage] {
            lock.lock()
            reads += 1
            let snapshot = rows
            let error = readError
            let gate = readGate
            lock.unlock()
            if let gate { await gate.wait() }
            if let error { throw error }
            return snapshot
        }

        func deleteQueuedMessage(sessionId: String, messageId: String) async throws {
            lock.lock(); defer { lock.unlock() }
            if let writeError { throw writeError }
            deleted.append(messageId)
            rows.removeAll { $0.id == messageId }
        }

        func editQueuedMessage(sessionId: String, messageId: String, text: String) async throws {
            lock.lock(); defer { lock.unlock() }
            if let writeError { throw writeError }
            edited.append((messageId, text))
        }

        func sendQueuedNow(messageId: String, interrupt: Bool) async throws {
            lock.lock(); defer { lock.unlock() }
            if let writeError { throw writeError }
            sentNow.append((messageId, interrupt))
            rows.removeAll { $0.id == messageId }
        }
    }

    private func row(_ id: String, _ text: String = "words", status: String = "pending") -> SessionQueuedMessage {
        SessionQueuedMessage(id: id, message: text, status: status, enqueuedAt: "2026-11-04T00:00:00Z")
    }

    private func conflict() -> APIError {
        .server(status: 409, code: "conflict", message: "Already started", serverHash: nil, serverContent: nil)
    }

    private func model(_ transport: Transport) -> SessionQueueModel {
        SessionQueueModel(sessionId: "qs-1", api: transport)
    }

    // MARK: - Pace of the read clock

    func testThePaceFollowsHowLikelyTheListIsToChange() {
        let p = SessionQueueModel.pollInterval
        XCTAssertEqual(p(true, true, 0), 3)
        XCTAssertEqual(p(false, true, 0), 5)
        XCTAssertEqual(p(true, false, 0), 6)
        XCTAssertEqual(p(false, false, 0), 15)
    }

    func testAnUnansweredServerIsAskedLessAndLessButNeverLessThanEveryMinute() {
        let p = SessionQueueModel.pollInterval
        XCTAssertEqual(p(true, true, 1), 6)
        XCTAssertEqual(p(true, true, 2), 12)
        XCTAssertLessThanOrEqual(p(true, true, 50), 60)
        XCTAssertLessThanOrEqual(p(false, false, 50), 60)
        XCTAssertGreaterThan(p(true, true, 3), p(true, true, 0))
    }

    // MARK: - Reading

    func testRefreshShowsTheServersRows() async {
        let t = Transport()
        t.rows = [row("qm-a"), row("qm-b")]
        let m = model(t)
        XCTAssertFalse(m.hasRows)
        await m.refresh()
        XCTAssertEqual(m.rows.map(\.id), ["qm-a", "qm-b"])
        XCTAssertTrue(m.loaded)
    }

    func testAFailedReadKeepsWhatWasShown() async {
        let t = Transport()
        t.rows = [row("qm-a")]
        let m = model(t)
        await m.refresh()
        t.readError = APIError.server(status: 503, code: "bridge_offline", message: "x", serverHash: nil, serverContent: nil)
        await m.refresh()
        XCTAssertEqual(m.rows.map(\.id), ["qm-a"], "an empty strip is a claim the app cannot back")
    }

    func testAReadThatStartedBeforeAWriteCannotPutTheOldListBack() async {
        let t = Transport()
        t.rows = [row("qm-a"), row("qm-b")]
        let m = model(t)
        await m.refresh()
        let gate = CheckedContinuationGate()
        t.readGate = gate
        let slow = Task { await m.refresh() }
        try? await Task.sleep(for: .milliseconds(30))
        t.readGate = nil
        await m.withdraw(m.rows[0])
        XCTAssertEqual(m.rows.map(\.id), ["qm-b"])
        gate.open()
        await slow.value
        XCTAssertEqual(m.rows.map(\.id), ["qm-b"], "the slow read held the list from before the withdraw")
    }

    // MARK: - Withdraw

    func testWithdrawRemovesTheRowAndTellsThePageWhichMessageWentAway() async {
        let t = Transport()
        t.rows = [row("qm-a"), row("qm-b")]
        let m = model(t)
        await m.refresh()
        var told: [String] = []
        m.onWithdrawn = { told.append($0) }
        await m.withdraw(m.rows[0])
        XCTAssertEqual(t.deleted, ["qm-a"])
        XCTAssertEqual(m.rows.map(\.id), ["qm-b"])
        XCTAssertEqual(told, ["qm-a"])
        XCTAssertTrue(m.busyIds.isEmpty)
    }

    func testAWithdrawnMessageCanBeTakenBackForAMoment() async {
        let t = Transport()
        t.rows = [row("qm-a", "keep these words")]
        let m = model(t)
        await m.refresh()
        await m.withdraw(m.rows[0])
        XCTAssertEqual(m.withdrawn, WithdrawnQueuedMessage(id: "qm-a", text: "keep these words", wasLast: true))
        m.clearUndo()
        XCTAssertNil(m.withdrawn)
    }

    func testUndoSaysWhenTheMessageWillComeBackLast() async {
        let t = Transport()
        t.rows = [row("qm-a", "first"), row("qm-b", "second")]
        let m = model(t)
        await m.refresh()
        await m.withdraw(m.rows[0])
        XCTAssertEqual(m.withdrawn?.wasLast, false, "others stood behind it: Undo puts it at the back")
        await m.withdraw(m.rows[0])
        XCTAssertEqual(m.withdrawn?.wasLast, true)
    }

    func testTheOfferToTakeItBackLapses() async {
        SessionQueueModel.undoWindow = 0.05
        defer { SessionQueueModel.undoWindow = 6 }
        let t = Transport()
        t.rows = [row("qm-a")]
        let m = model(t)
        await m.refresh()
        await m.withdraw(m.rows[0])
        XCTAssertNotNil(m.withdrawn)
        let deadline = Date().addingTimeInterval(3)
        while m.withdrawn != nil, Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertNil(m.withdrawn, "the offer ends by itself")
    }

    func testAFailedWithdrawOffersNoUndo() async {
        let t = Transport()
        t.rows = [row("qm-a")]
        t.writeError = APIError.server(status: 503, code: "bridge_offline", message: "x", serverHash: nil, serverContent: nil)
        let m = model(t)
        await m.refresh()
        await m.withdraw(m.rows[0])
        XCTAssertNil(m.withdrawn)
    }

    func testTheHeadlineSaysWhatIsAboutToHappen() {
        XCTAssertEqual([row("a")].headline(turnRunning: true), "Waiting to go in")
        XCTAssertEqual([row("a")].headline(turnRunning: false), "Going out now")
        XCTAssertEqual([row("a", status: "processing")].headline(turnRunning: true), "Going out now")
        XCTAssertEqual([row("a", status: "parked")].headline(turnRunning: false), "Stopped \u{00B7} not sent")
        XCTAssertEqual([row("a", status: "held")].headline(turnRunning: false), "Waiting for your Mac")
        // A message that will go out wins over one that was set aside: the line is true of the next delivery.
        XCTAssertEqual([row("a", status: "parked"), row("b")].headline(turnRunning: true), "Waiting to go in")
    }

    func testAFailedWithdrawBringsTheRowBackWithAReason() async {
        let t = Transport()
        t.rows = [row("qm-a")]
        let m = model(t)
        await m.refresh()
        t.writeError = APIError.server(status: 503, code: "bridge_offline", message: "x", serverHash: nil, serverContent: nil)
        var told: [String] = []
        m.onWithdrawn = { told.append($0) }
        await m.withdraw(m.rows[0])
        XCTAssertEqual(m.rows.map(\.id), ["qm-a"])
        XCTAssertTrue(told.isEmpty, "the bubble stays: the message is still queued")
        XCTAssertEqual(m.notice, "Can't reach your Mac right now. Try again in a moment.")
    }

    func testAWithdrawOfAMessageThatStartedDeliveringReadsTheListAgain() async {
        let t = Transport()
        t.rows = [row("qm-a")]
        let m = model(t)
        await m.refresh()
        t.writeError = conflict()
        t.rows = [row("qm-a", status: "processing")]
        await m.withdraw(m.rows[0])
        XCTAssertEqual(m.notice, "That message already started delivering.")
        XCTAssertEqual(m.rows.first?.status, "processing", "the server's list is the truth")
    }

    // MARK: - Edit

    func testEditKeepsTheRowAndTellsThePageTheNewWords() async {
        let t = Transport()
        t.rows = [row("qm-a", "old")]
        let m = model(t)
        await m.refresh()
        var told: [(String, String)] = []
        m.onEdited = { told.append(($0, $1)) }
        let ok = await m.edit(m.rows[0], to: "  new words \n")
        XCTAssertTrue(ok)
        XCTAssertEqual(t.edited.first?.1, "new words")
        XCTAssertEqual(m.rows.first?.message, "new words")
        XCTAssertEqual(told.first?.0, "qm-a")
        XCTAssertEqual(told.first?.1, "new words")
    }

    func testEmptyWordsAreNeverSaved() async {
        let t = Transport()
        t.rows = [row("qm-a", "old")]
        let m = model(t)
        await m.refresh()
        let ok = await m.edit(m.rows[0], to: "   \n")
        XCTAssertFalse(ok)
        XCTAssertTrue(t.edited.isEmpty)
    }

    func testAnEditOfAMessageThatStartedDeliveringSaysSoAndReadsAgain() async {
        let t = Transport()
        t.rows = [row("qm-a", "old")]
        let m = model(t)
        await m.refresh()
        t.writeError = conflict()
        t.rows = [row("qm-a", "old", status: "processing")]
        let ok = await m.edit(m.rows[0], to: "new")
        XCTAssertFalse(ok)
        XCTAssertEqual(m.notice, "That message already started delivering.")
        XCTAssertEqual(m.rows.first?.message, "old")
    }

    // MARK: - Send now

    func testSendNowWhileATurnRunsInterruptsIt() async {
        let t = Transport()
        t.rows = [row("qm-a")]
        let m = model(t)
        await m.refresh()
        let ok = await m.sendNow(m.rows[0], interrupt: true)
        XCTAssertTrue(ok)
        XCTAssertEqual(t.sentNow.first?.0, "qm-a")
        XCTAssertEqual(t.sentNow.first?.1, true)
        XCTAssertTrue(m.rows.isEmpty, "the list is read again after")
    }

    func testSendNowWithNothingRunningDoesNotInterrupt() async {
        let t = Transport()
        t.rows = [row("qm-a")]
        let m = model(t)
        await m.refresh()
        _ = await m.sendNow(m.rows[0], interrupt: false)
        XCTAssertEqual(t.sentNow.first?.1, false)
    }

    func testSendNowOfAGoneRowSaysItIsNoLongerWaiting() async {
        for code in ["conflict", "not_queued"] {
            let t = Transport()
            t.rows = [row("qm-a")]
            let m = model(t)
            await m.refresh()
            t.writeError = APIError.server(status: 409, code: code, message: "gone", serverHash: nil, serverContent: nil)
            t.rows = []
            let ok = await m.sendNow(m.rows[0], interrupt: true)
            XCTAssertFalse(ok, code)
            XCTAssertEqual(m.notice, "That message is no longer waiting.", code)
            XCTAssertTrue(m.rows.isEmpty, code)
        }
    }

    func testSendNowOnTheCompanionSaysItNeedsTheMac() async {
        let t = Transport()
        t.rows = [row("qm-a")]
        let m = model(t)
        await m.refresh()
        t.writeError = APIError.server(status: 501, code: "not_supported_cloud", message: "x", serverHash: nil, serverContent: nil)
        let ok = await m.sendNow(m.rows[0], interrupt: false)
        XCTAssertFalse(ok)
        XCTAssertEqual(m.notice, "Send now needs your Mac online.")
        XCTAssertEqual(m.rows.map(\.id), ["qm-a"])
    }

    // MARK: - What a row may do

    func testRowRulesMatchWhatTheServerAllows() {
        let pending = row("a", status: "pending")
        XCTAssertTrue(pending.canEdit)
        XCTAssertTrue(pending.canWithdraw)
        XCTAssertTrue(pending.canSendNow)
        XCTAssertNil(pending.statusNote)

        let parked = row("b", status: "parked")
        XCTAssertTrue(parked.canEdit)
        XCTAssertTrue(parked.canWithdraw)
        XCTAssertTrue(parked.canSendNow)
        XCTAssertEqual(parked.statusNote, "Not sent")

        let processing = row("c", status: "processing")
        XCTAssertFalse(processing.canEdit)
        XCTAssertFalse(processing.canWithdraw)
        XCTAssertFalse(processing.canSendNow)
        XCTAssertEqual(processing.statusNote, "Delivering…")

        let held = row("d", status: "held")
        XCTAssertFalse(held.canEdit)
        XCTAssertFalse(held.canWithdraw)
        XCTAssertFalse(held.canSendNow)
        XCTAssertEqual(held.statusNote, "Waiting for your Mac")
    }

    func testEveryQueueFailureReadsAsASentence() {
        for code in ["bridge_offline", "not_found", "not_supported_cloud", "internal"] {
            let text = SessionConversationStore.queueFailureText(APIError.server(
                status: 500, code: code, message: "Something went wrong.", serverHash: nil, serverContent: nil
            ))
            XCTAssertFalse(text.isEmpty, code)
            XCTAssertFalse(text.contains(code), code)
        }
    }
}

/// The composer's second button: when it appears and when it must not.
final class ComposerInterruptSendTests: XCTestCase {
    private func offers(
        canInterrupt: Bool = true, busy: Bool = true, pendingQuestion: Bool = false, hasContent: Bool = true,
        disabled: Bool = false, importingFiles: Int = 0, voiceIdle: Bool = true, sendWaiting: Bool = false
    ) -> Bool {
        ComposerPrimaryAction.offersInterruptSend(
            canInterrupt: canInterrupt, busy: busy, pendingQuestion: pendingQuestion, hasContent: hasContent,
            disabled: disabled, importingFiles: importingFiles, voiceIdle: voiceIdle, sendWaiting: sendWaiting
        )
    }

    func testItAppearsWhileATurnRunsAndSomethingIsTyped() {
        XCTAssertTrue(offers())
    }

    func testEveryOtherStateHidesIt() {
        XCTAssertFalse(offers(canInterrupt: false), "the chat tab has no owner for it")
        XCTAssertFalse(offers(busy: false), "nothing to interrupt")
        XCTAssertFalse(offers(pendingQuestion: true), "the words answer the agent's question")
        XCTAssertFalse(offers(hasContent: false), "nothing to send")
        XCTAssertFalse(offers(disabled: true))
        XCTAssertFalse(offers(importingFiles: 1), "a file is still being read")
        XCTAssertFalse(offers(voiceIdle: false), "the recorder holds the field")
        XCTAssertFalse(offers(sendWaiting: true), "a send already waits for its words")
    }
}


/// A double tap on the composer's trailing seat must not stop the agent or open voice mode.
final class SeatTapGuardTests: XCTestCase {
    func testAFreshSeatTakesATap() {
        XCTAssertTrue(SeatTapGuard().allows())
    }

    func testATapRightAfterATapOnTheSeatIsIgnored() {
        var seat = SeatTapGuard()
        let t0 = Date(timeIntervalSince1970: 1_000)
        seat.record(at: t0)
        XCTAssertFalse(seat.allows(at: t0.addingTimeInterval(0.05)), "a double tap")
        XCTAssertFalse(seat.allows(at: t0.addingTimeInterval(0.6)), "a slow double tap")
        XCTAssertFalse(seat.allows(at: t0.addingTimeInterval(SeatTapGuard.window - 0.01)))
    }

    func testALaterTapIsADecision() {
        var seat = SeatTapGuard()
        let t0 = Date(timeIntervalSince1970: 1_000)
        seat.record(at: t0)
        XCTAssertTrue(seat.allows(at: t0.addingTimeInterval(SeatTapGuard.window)))
        XCTAssertTrue(seat.allows(at: t0.addingTimeInterval(30)))
    }

    func testARowGuardHasItsOwnShorterSpan() {
        var row = SeatTapGuard(span: 1.0)
        let t0 = Date(timeIntervalSince1970: 1_000)
        row.record(at: t0)
        XCTAssertFalse(row.allows(at: t0.addingTimeInterval(0.9)))
        XCTAssertTrue(row.allows(at: t0.addingTimeInterval(1.0)))
        XCTAssertLessThan(row.span, SeatTapGuard().span)
    }
}
