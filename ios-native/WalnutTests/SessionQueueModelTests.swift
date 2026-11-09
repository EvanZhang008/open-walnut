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
        let p = { SessionQueueModel.pollInterval(turnRunning: $0, hasRows: $1, failures: $2) }
        XCTAssertEqual(p(true, true, 0), 3)
        XCTAssertEqual(p(false, true, 0), 5)
        XCTAssertEqual(p(true, false, 0), 6)
        XCTAssertEqual(p(false, false, 0), 15)
        XCTAssertEqual(SessionQueueModel.pollInterval(turnRunning: false, hasRows: false, failures: 0, watching: true), 1.5,
                       "a send on its way is read often, so its Queued turns Delivered at once")
    }

    func testAnUnansweredServerIsAskedLessAndLessButNeverLessThanEveryMinute() {
        let p = { SessionQueueModel.pollInterval(turnRunning: $0, hasRows: $1, failures: $2) }
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

    func testARowThatLeavesTheLineByItselfTellsThePageToReadTheTranscript() async {
        let t = Transport()
        t.rows = [row("qm-a"), row("qm-b")]
        let m = model(t)
        var told = 0
        m.onRowsLeft = { told += 1 }
        await m.refresh()
        XCTAssertEqual(told, 0, "the first read only shows the line")
        t.rows = [row("qm-b")]
        await m.refresh()
        XCTAssertEqual(told, 1, "qm-a went out")
        await m.refresh()
        XCTAssertEqual(told, 1)
        t.rows.append(row("qm-c"))
        await m.refresh()
        XCTAssertEqual(told, 1, "a message coming in is not one leaving")
    }

    func testAWithdrawalTheLineAlreadyShowsDoesNotTellThePage() async {
        let t = Transport()
        t.rows = [row("qm-a"), row("qm-b")]
        let m = model(t)
        var told = 0
        m.onRowsLeft = { told += 1 }
        await m.refresh()
        await m.withdraw(row("qm-a"))
        await m.refresh()
        XCTAssertEqual(told, 0)
    }

    func testUnsavedWordsAreKeptWhenTheirMessageWentOutFirst() {
        typealias Sheet = SessionQueuedMessageSheet
        XCTAssertEqual(Sheet.strandedWords(text: "  R: reply with R-NEW \n", original: "R: reply with R-ORIG"),
                       "R: reply with R-NEW")
        XCTAssertNil(Sheet.strandedWords(text: "R: reply with R-ORIG", original: "R: reply with R-ORIG"), "nothing changed")
        XCTAssertNil(Sheet.strandedWords(text: " R: reply with R-ORIG\n", original: "R: reply with R-ORIG"), "only spacing")
        XCTAssertNil(Sheet.strandedWords(text: "   ", original: "R: reply with R-ORIG"), "an emptied box has nothing to keep")
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
        XCTAssertEqual(m.withdrawn, WithdrawnQueuedMessage(
            id: "qm-a", text: "keep these words", followers: [], wasSetAside: false, enqueuedAt: "2026-11-04T00:00:00Z"
        ))
        m.clearUndo()
        XCTAssertNil(m.withdrawn)
    }

    func testARowActionRightBehindAnotherOneIsIgnored() {
        let m = model(Transport())
        let t0 = Date(timeIntervalSince1970: 1_000)
        XCTAssertTrue(m.takeRowTap(at: t0))
        XCTAssertFalse(m.takeRowTap(at: t0.addingTimeInterval(0.3)), "the second tap of a double tap")
        XCTAssertTrue(m.takeRowTap(at: t0.addingTimeInterval(1.1)))
    }

    func testUndoIsAlwaysADecisionButShieldsTheRowsThatMoveIntoItsPlace() {
        let m = model(Transport())
        let t0 = Date(timeIntervalSince1970: 1_000)
        XCTAssertTrue(m.takeRowTap(at: t0), "the cross")
        m.noteRowTap(at: t0.addingTimeInterval(0.4))
        XCTAssertFalse(m.takeRowTap(at: t0.addingTimeInterval(0.8)), "a cross under the finger that tapped Undo")
        XCTAssertTrue(m.takeRowTap(at: t0.addingTimeInterval(1.5)))
    }

    func testUndoRemembersWhoStoodBehindTheMessageSoTheOrderCanBeKept() async {
        let t = Transport()
        t.rows = [row("qm-a", "first"), row("qm-b", "second"), row("qm-c", "third", status: "parked")]
        let m = model(t)
        await m.refresh()
        await m.withdraw(m.rows[0])
        XCTAssertEqual(m.withdrawn?.followers.map(\.id), ["qm-b"], "only the ones still waiting are sent again behind it")
        XCTAssertEqual(m.withdrawn?.wasSetAside, false)
        await m.withdraw(m.rows[1])
        XCTAssertEqual(m.withdrawn?.wasSetAside, true, "a Stop had set it aside: Undo returns it to the box")
        XCTAssertEqual(m.withdrawn?.followers, [])
    }

    private func timed(_ id: String, _ text: String, _ second: Int, status: String = "pending") -> SessionQueuedMessage {
        SessionQueuedMessage(id: id, message: text, status: status, enqueuedAt: String(format: "2026-11-04T00:00:%02dZ", second))
    }

    func testAnotherWithdrawalWhileTheOfferStandsJoinsIt() async {
        let t = Transport()
        t.rows = [timed("qm-a", "first", 1), timed("qm-b", "second", 2), timed("qm-c", "third", 3)]
        let m = model(t)
        await m.refresh()
        await m.withdraw(m.rows[0])
        await m.withdraw(m.rows[1])
        XCTAssertEqual(m.withdrawn?.id, "qm-c")
        XCTAssertEqual(m.withdrawn?.all.map(\.id), ["qm-a", "qm-c"], "one Undo gives both back")
        XCTAssertEqual(m.withdrawn?.earlier.map(\.id), ["qm-a"])
    }

    func testUndoPutsSeveralMessagesBackInTheOrderTheyStoodIn() {
        let a = timed("qm-a", "first", 1), b = timed("qm-b", "second", 2), c = timed("qm-c", "third", 3)
        // a was withdrawn (b and c stood behind it), then c.
        let first = WithdrawnQueuedMessage(id: "qm-a", text: "first", followers: [b, c], wasSetAside: false, enqueuedAt: a.enqueuedAt)
        let both = WithdrawnQueuedMessage(id: "qm-c", text: "third", followers: [], wasSetAside: false,
                                          enqueuedAt: c.enqueuedAt, earlier: [first])
        let plan = both.restorePlan(rows: [b])
        XCTAssertEqual(plan.steps.map(\.text), ["first", "second", "third"])
        XCTAssertEqual(plan.steps.map(\.pullRowID), [nil, "qm-b", nil], "the one still waiting is taken off the line and sent again in its place")
        XCTAssertNil(plan.draftText)
    }

    func testUndoSkipsAFollowerThatLeftTheLineAndHandsSetAsideWordsToTheBox() {
        let a = timed("qm-a", "first", 1), b = timed("qm-b", "second", 2)
        let aside = WithdrawnQueuedMessage(id: "qm-p", text: "parked words", followers: [], wasSetAside: true, enqueuedAt: nil)
        let latest = WithdrawnQueuedMessage(id: "qm-a", text: "first", followers: [b], wasSetAside: false,
                                            enqueuedAt: a.enqueuedAt, earlier: [aside])
        let plan = latest.restorePlan(rows: [])
        XCTAssertEqual(plan.steps.map(\.text), ["first"], "qm-b went out meanwhile: gone is gone")
        XCTAssertEqual(plan.draftText, "parked words")
    }

    func testSendAllPutsEveryHeldMessageBackInLineInOrder() async {
        let t = Transport()
        t.rows = [timed("qm-a", "first", 1, status: "parked"), timed("qm-b", "second", 2, status: "parked"),
                  timed("qm-c", "third", 3)]
        let m = model(t)
        await m.refresh()
        XCTAssertEqual(m.heldCount, 2, "only the ones a Stop held back")
        await m.sendAllHeld()
        XCTAssertEqual(t.sentNow.map(\.0), ["qm-a", "qm-b"], "in the order they stood in, the waiting one untouched")
        XCTAssertEqual(t.sentNow.map(\.1), [false, false], "nothing runs, so nothing is interrupted")
    }

    func testPullingAMessageOffTheLineForRequeueTellsThePageAndKeepsNoUndo() async {
        let t = Transport()
        t.rows = [row("qm-a", "first")]
        let m = model(t)
        var gone: [String] = []
        m.onWithdrawn = { gone.append($0) }
        await m.refresh()
        let pulled = await m.pullForRequeue(m.rows[0])
        XCTAssertTrue(pulled)
        XCTAssertEqual(gone, ["qm-a"])
        XCTAssertTrue(m.rows.isEmpty)
        XCTAssertNil(m.withdrawn, "the pull is part of an Undo, not a withdrawal")
    }

    func testWhileUndoPutsMessagesBackTheLineStandsAsItWillEndUpAndKeepsTheirFirstTimes() async {
        let t = Transport()
        let a = timed("qm-a", "first", 1), b = timed("qm-b", "second", 2)
        t.rows = [b]
        let m = model(t)
        await m.refresh()
        let gone = WithdrawnQueuedMessage(id: "qm-a", text: "first", followers: [b], wasSetAside: false, enqueuedAt: a.enqueuedAt)
        let plan = gone.restorePlan(rows: m.rows)
        m.beginRestore(gone: gone)
        XCTAssertEqual(m.rows.map(\.id), ["qm-a", "qm-b"], "the returning message stands where its time puts it")
        // Half way: the server holds nothing (b was taken off, a not yet sent). The list must not show that.
        t.rows = []
        await m.refresh()
        XCTAssertEqual(m.rows.map(\.id), ["qm-a", "qm-b"], "a read in between changes nothing")
        // Both sent again, with new ids and the time of now.
        t.rows = [SessionQueuedMessage(id: "qm-x", message: "first", status: "pending", enqueuedAt: "2026-11-04T12:00:00Z"),
                  SessionQueuedMessage(id: "qm-y", message: "second", status: "pending", enqueuedAt: "2026-11-04T12:00:01Z")]
        await m.endRestore(plan: plan)
        XCTAssertEqual(m.rows.map(\.id), ["qm-x", "qm-y"])
        XCTAssertEqual(m.rows.map(\.enqueuedAt), [a.enqueuedAt, b.enqueuedAt], "each shows the time it first went in")
        // And the next read keeps them.
        await m.refresh()
        XCTAssertEqual(m.rows.map(\.enqueuedAt), [a.enqueuedAt, b.enqueuedAt])
    }

    func testARowAnInterruptingSendJustPutInLineStaysOutOfTheListUntilTheSpanEnds() async {
        SessionQueueModel.goingOutSpan = 0.3
        defer { SessionQueueModel.goingOutSpan = 4 }
        let t = Transport()
        t.rows = [row("qm-a"), row("qm-b")]
        let m = model(t)
        m.hideWhileGoingOut("qm-a")
        await m.refresh()
        XCTAssertEqual(m.rows.map(\.id), ["qm-b"], "its bubble is on the page: no second copy under the list")
        let deadline = Date().addingTimeInterval(3)
        while m.rows.count < 2, Date() < deadline { try? await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(m.rows.map(\.id), ["qm-a", "qm-b"], "a send that sticks is shown after all")
    }

    func testTheOfferToTakeItBackLapses() async {
        SessionQueueModel.undoWindow = 0.05
        defer { SessionQueueModel.undoWindow = 15 }
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
        XCTAssertEqual([row("a")].headline(turnRunning: true), "Sends after this turn")
        XCTAssertEqual([row("a")].headline(turnRunning: false), "Going out now")
        XCTAssertEqual([row("a", status: "processing")].headline(turnRunning: true), "Going out now")
        XCTAssertEqual([row("a", status: "parked")].headline(turnRunning: false), "Stopped \u{00B7} not sent")
        XCTAssertEqual([row("a", status: "parked")].headline(turnRunning: true), "Not sent",
                       "a turn runs again: the words say what is still true of the rows, not that the session is stopped")
        XCTAssertEqual([row("a", status: "held")].headline(turnRunning: false), "Waiting for your Mac")
        // A message that will go out wins over one that was set aside: the line is true of the next delivery.
        XCTAssertEqual([row("a", status: "parked"), row("b")].headline(turnRunning: true), "Sends after this turn")
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
        // Handed to the session (processing, the web's rule): it is no longer in the line.
        XCTAssertTrue(m.rows.isEmpty, "the server's list is the truth: the message went in")
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
        XCTAssertTrue(m.rows.isEmpty, "it went in with its old words: nothing left to edit")
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

    // MARK: - Each message's own state (no card), the web's way

    /// A send of this page reads Queued while its row waits, Delivered for a moment once the
    /// session has it, then nothing; and never Queued or Delivering after the server says it
    /// was handed over, whatever stage it reports (2026-11-09: the owner's phone said
    /// "Delivering" while the session was already thinking).
    func testASendReadsQueuedThenDeliveredThenNothing() async {
        let transport = Transport()
        let queue = model(transport)
        let saved = SessionQueueModel.deliveredSpan
        SessionQueueModel.deliveredSpan = 0.3
        defer { SessionQueueModel.deliveredSpan = saved }
        transport.rows = [row("qm-a")]
        queue.watch("qm-a")
        await queue.refresh()
        XCTAssertEqual(queue.sendStates["qm-a"], .pending, "waiting to go in: Queued on its bubble")
        XCTAssertTrue(queue.trayRows.isEmpty, "a waiting message is no card")
        for stage in [nil, "waiting", "written", "taken"] as [String?] {
            var handed = row("x", status: "processing")
            handed.stage = stage
            XCTAssertTrue(handed.isDelivered, "processing, stage \(stage ?? "nil"): delivered")
        }
        transport.rows = [row("qm-a", status: "processing")]
        await queue.refresh()
        XCTAssertEqual(queue.sendStates["qm-a"], .delivered, "handed to the session: Delivered")
        try? await Task.sleep(for: .seconds(0.6))
        XCTAssertNil(queue.sendStates["qm-a"], "Delivered fades, the bubble is a plain message")
    }

    /// A row gone from the line before the page ever read it (delivered mid-turn at once) is
    /// delivered, never left Queued.
    func testASendGoneFromTheLineIsDelivered() async {
        let transport = Transport()
        let queue = model(transport)
        queue.watch("qm-b")
        XCTAssertEqual(queue.sendStates["qm-b"], .pending, "accepted, not read yet")
        await queue.refresh()
        XCTAssertEqual(queue.sendStates["qm-b"], .delivered)
    }

    /// A read that left before the send was accepted cannot see it: its absence there is no
    /// delivery (the send would read Delivered, then Queued again).
    func testAReadFromBeforeTheSendIsNoDelivery() async {
        let queue = model(Transport())
        queue.watch("qm-c")
        queue.updateSendStates(fetched: [], read: 0)
        XCTAssertEqual(queue.sendStates["qm-c"], .pending, "an older read's empty line proves nothing")
        queue.updateSendStates(fetched: [], read: 5)
        XCTAssertEqual(queue.sendStates["qm-c"], .delivered, "a later read without it: delivered")
    }

    /// The fast read follows a send only for a while: a send that waits long (an engine that
    /// takes it at the turn's end, a host away) goes back to the normal pace.
    func testTheFastReadEndsWhileASendStillWaits() {
        let queue = model(Transport())
        queue.watch("qm-d")
        XCTAssertTrue(queue.watchingFast())
        XCTAssertFalse(queue.watchingFast(now: Date().addingTimeInterval(SessionQueueModel.watchFastSpan + 1)))
    }

    /// Waiting bubbles read in the server's order, another device's included; the rest of the
    /// conversation stays where it is.
    func testWaitingBubblesFollowTheServersOrder() {
        func bubble(_ id: String, _ client: String?) -> ChatMessage {
            var m = ChatMessage(id: id, role: "user", text: id, createdAt: "", kind: nil)
            m.clientMessageId = client
            return m
        }
        func waiting(_ id: String, _ at: String) -> SessionQueuedMessage {
            SessionQueuedMessage(id: id, message: id, status: "pending", enqueuedAt: at)
        }
        let rows = ["qm-mine": waiting("qm-mine", "2026-11-09T10:00:02Z"),
                    "qm-other": waiting("qm-other", "2026-11-09T10:00:01Z")]
        let page = [bubble("old", nil), bubble("mine", "qm-mine"), SessionTimelineBody.bubble(for: rows["qm-other"]!)]
        XCTAssertEqual(SessionTimelineBody.inServerOrder(page, rows: rows).map(\.id), ["old", "queued-qm-other", "mine"])
    }

    /// Only the two tabs keep an Org node's page: anywhere else a session page opens keeps none.
    func testOnlyTheTabsKeepAnOrgPage() {
        XCTAssertEqual(OrgPagePlace.chat.keyId("n1"), "n1")
        XCTAssertEqual(OrgPagePlace.tasks.keyId("n1"), "tasks.n1")
        XCTAssertNil(OrgPagePlace.other.keyId("n1"))
    }

    /// Only a row that needs a hand is a card: set aside by a Stop, or held on the companion.
    func testTheCardListsOnlyRowsThatNeedAHand() async {
        let transport = Transport()
        let queue = model(transport)
        transport.rows = [row("p1"), row("s1", status: "parked"), row("h1", status: "held")]
        await queue.refresh()
        XCTAssertEqual(queue.trayRows.map(\.id), ["s1", "h1"])
        XCTAssertEqual(queue.waitingRowsWithoutBubble(["p1"]).count, 0, "its own bubble stands for it")
        XCTAssertEqual(queue.waitingRowsWithoutBubble([]).map(\.id), ["p1"], "another device's: drawn as a bubble")
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

    // MARK: - The Withdraw button's words

    /// Words on a bordered destructive button sit on the danger tint at a quarter strength over the
    /// sheet: that pair must clear the text bar in both appearances.
    func testTheWithdrawLabelClearsTheTextBarOnItsOwnFill() {
        func linear(_ v: CGFloat) -> Double {
            let c = Double(v)
            return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        func luminance(_ color: UIColor, _ traits: UITraitCollection) -> Double {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            color.resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
            return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
        }
        for dark in [false, true] {
            let traits = UITraitCollection { $0.userInterfaceStyle = dark ? .dark : .light }
            for sheet in [UIColor.systemBackground, UIColor.secondarySystemBackground] {
                func channels(_ color: UIColor) -> (CGFloat, CGFloat, CGFloat) {
                    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
                    color.resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
                    return (r, g, b)
                }
                let f = channels(Theme.dangerColor)
                let p = channels(sheet)
                let fill = UIColor(
                    red: p.0 + (f.0 - p.0) * 0.25, green: p.1 + (f.1 - p.1) * 0.25,
                    blue: p.2 + (f.2 - p.2) * 0.25, alpha: 1
                )
                let ink = luminance(Theme.dangerTextColor, traits)
                let paper = luminance(fill, traits)
                let ratio = (max(ink, paper) + 0.05) / (min(ink, paper) + 0.05)
                XCTAssertGreaterThanOrEqual(ratio, 4.5, "dark=\(dark): \(ratio):1")
            }
        }
    }
}
