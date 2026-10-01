import SwiftUI
import UIKit
import XCTest
@testable import Walnut

/// Scripted `LetterReplyTransport`: every call recorded in order, a scripted
/// outcome per call, and a gate that holds a call open so a test can act while
/// it is genuinely in flight.
final class ScriptedReplyTransport: LetterReplyTransport, @unchecked Sendable {
    struct Call: Equatable { let letterId: String; let text: String; let clientId: String }

    private let lock = NSLock()
    private var outcomes: [Error?] = []
    private var recorded: [Call] = []
    var gate: CheckedContinuationGate?
    /// What the server's letter records on the reply turn (nil = an older server).
    var recordsDelivery = true
    var deliveryStatus = "queued"

    func script(_ next: [Error?]) { lock.withLock { outcomes += next } }
    var calls: [Call] { lock.withLock { recorded } }

    func replyToLetter(id: String, text: String, clientId: String) async throws -> LetterActionResult {
        let (outcome, gate): (Error?, CheckedContinuationGate?) = lock.withLock {
            recorded.append(Call(letterId: id, text: text, clientId: clientId))
            return (outcomes.isEmpty ? nil : outcomes.removeFirst(), self.gate)
        }
        await gate?.wait()
        if let outcome { throw outcome }
        let delivery = recordsDelivery
            ? #", "clientId": "\#(clientId)", "delivery": { "status": "\#(deliveryStatus)", "sessionId": "sess-1", "at": 1800000000500 }"#
            : ""
        let json = """
        { "letter": { "id": "\(id)", "subject": "S", "type": "review", "body": "b",
                      "thread": [ { "from": "human", "text": \(Self.quoted(text)), "at": 1800000000000\(delivery) } ] },
          "delivery": { "status": "\(deliveryStatus)", "sessionId": "sess-1", "messageId": "qm-1" } }
        """
        return try JSONDecoder().decode(LetterActionResult.self, from: Data(json.utf8))
    }

    private static func quoted(_ s: String) -> String {
        String(data: try! JSONEncoder().encode(s), encoding: .utf8)!
    }
}

private func serverError(_ status: Int, _ code: String, _ message: String) -> APIError {
    APIError.server(status: status, code: code, message: message, serverHash: nil, serverContent: nil)
}

/// The letter reply box's rules: the field empties when the reply is handed
/// over, a failure keeps every word with Retry and Edit, Retry sends once and
/// with the same id, drafts survive leaving a letter, and the status line under
/// a reply names who it went to and when, in plain words.
@MainActor
final class LetterReplyStoreTests: XCTestCase {
    /// The companion's sentence when there is no bridge at all (bridge-offline-copy.ts).
    static let noBridge = "No live bridge to the primary box. Your primary box (Mac) is asleep or offline."

    func testSendEmptiesTheDraftAndShowsThePendingReplyUntilTheServerAnswers() async throws {
        let transport = ScriptedReplyTransport()
        let gate = CheckedContinuationGate()
        transport.gate = gate
        let store = LetterReplyStore(transport: transport)
        store.setDraft("Looks right, ship it.", for: "lt-a")

        let sending = Task { await store.send(letterId: "lt-a", text: "Looks right, ship it.") }
        await waitUntil { !transport.calls.isEmpty }
        XCTAssertEqual(store.draft(for: "lt-a"), "", "the field must empty the moment the reply is handed over")
        XCTAssertEqual(store.pendingReplies(for: "lt-a").map(\.text), ["Looks right, ship it."])
        XCTAssertEqual(store.pendingReplies(for: "lt-a").first?.state, .sending)

        gate.open()
        let result = await sending.value
        XCTAssertNotNil(result)
        XCTAssertTrue(store.pendingReplies(for: "lt-a").isEmpty, "a reply the server has is shown once, as its turn")
        XCTAssertEqual(transport.calls.count, 1)
    }

    func testAFailedSendKeepsTheWordsAndRetrySendsOnceWithTheSameId() async throws {
        let transport = ScriptedReplyTransport()
        transport.script([serverError(503, "bridge_offline", Self.noBridge)])
        let store = LetterReplyStore(transport: transport)

        let failed = await store.send(letterId: "lt-a", text: "Please rerun it \u{7136}\u{540E}\u{544A}\u{8BC9}\u{6211}")
        XCTAssertNil(failed)
        let reply = try XCTUnwrap(store.pendingReplies(for: "lt-a").first)
        XCTAssertEqual(reply.text, "Please rerun it \u{7136}\u{540E}\u{544A}\u{8BC9}\u{6211}", "a failed send loses nothing")
        XCTAssertEqual(reply.state, .failed(
            "Your Mac is not connected to Walnut right now. Your reply is kept here; Retry when it is back."
        ), "the companion's own words are jargon; the human hears about their Mac")
        XCTAssertFalse(reply.mayHaveArrived, "no bridge: nothing reached the Mac")

        // Two Retry taps while the first is on its way: ONE request.
        let gate = CheckedContinuationGate()
        transport.gate = gate
        let first = Task { await store.retry(letterId: "lt-a", clientId: reply.id) }
        await waitUntil { transport.calls.count == 2 }
        let second = await store.retry(letterId: "lt-a", clientId: reply.id)
        XCTAssertNil(second, "a retry while one is in flight is the same retry")
        gate.open()
        let retried = await first.value
        XCTAssertNotNil(retried)

        XCTAssertEqual(transport.calls.count, 2)
        XCTAssertEqual(transport.calls[0].clientId, transport.calls[1].clientId,
                       "Retry must reuse the id, or a reply whose response was lost lands twice")
        XCTAssertEqual(transport.calls[1].text, "Please rerun it \u{7136}\u{540E}\u{544A}\u{8BC9}\u{6211}")
        XCTAssertTrue(store.pendingReplies(for: "lt-a").isEmpty)
    }

    func testEditPutsAFailedReplyBackAfterWhateverTheFieldHolds() async {
        let transport = ScriptedReplyTransport()
        transport.script([APIError.network(underlying: URLError(.cannotConnectToHost))])
        let store = LetterReplyStore(transport: transport)
        _ = await store.send(letterId: "lt-a", text: "First thought.")
        XCTAssertEqual(store.pendingReplies(for: "lt-a").first?.state, .failed("Walnut could not be reached."))

        store.setDraft("New start", for: "lt-a")
        let id = store.pendingReplies(for: "lt-a")[0].id
        store.edit(letterId: "lt-a", clientId: id)
        XCTAssertEqual(store.draft(for: "lt-a"), "New start First thought.")
        XCTAssertTrue(store.pendingReplies(for: "lt-a").isEmpty)
    }

    /// The gate's double send: the answer timed out although the server had
    /// recorded and delivered the reply, and Edit then sent it again under a
    /// new id. A lost answer offers Retry (same id, deduped) and no Edit, until
    /// a read of the letter made AFTER the loss settles it.
    func testALostAnswerOffersNoEditUntilAFreshReadSettlesIt() async throws {
        let transport = ScriptedReplyTransport()
        transport.script([APIError.network(underlying: URLError(.timedOut))])
        let store = LetterReplyStore(transport: transport)
        let before = Date()
        _ = await store.send(letterId: "lt-a", text: "Maybe on record.")
        let reply = try XCTUnwrap(store.pendingReplies(for: "lt-a").first)
        XCTAssertTrue(reply.mayHaveArrived)
        XCTAssertTrue(store.needsRecheck(letterId: "lt-a"), "the reader must re-read the letter")

        store.edit(letterId: "lt-a", clientId: reply.id)
        XCTAssertEqual(store.pendingReplies(for: "lt-a").count, 1, "Edit while it may be on record would send it twice")
        XCTAssertEqual(store.draft(for: "lt-a"), "")

        let without = try JSONDecoder().decode(Letter.self, from: Data(#"{ "id": "lt-a", "subject": "S", "type": "review", "thread": [] }"#.utf8))
        // A read that went out before the loss, or one that rode on another
        // response, proves nothing.
        store.reconcile(letterId: "lt-a", with: without, readStartedAt: before)
        XCTAssertTrue(store.pendingReplies(for: "lt-a")[0].mayHaveArrived)
        store.reconcile(letterId: "lt-a", with: without)
        XCTAssertTrue(store.pendingReplies(for: "lt-a")[0].mayHaveArrived)

        store.reconcile(letterId: "lt-a", with: without, readStartedAt: Date())
        XCTAssertFalse(store.pendingReplies(for: "lt-a")[0].mayHaveArrived, "a fresh read without it proves it never landed")
        XCTAssertFalse(store.needsRecheck(letterId: "lt-a"))
        store.edit(letterId: "lt-a", clientId: reply.id)
        XCTAssertEqual(store.draft(for: "lt-a"), "Maybe on record.")
    }

    func testRetryAfterALostAnswerReusesTheIdAndStaysUnconfirmedOnARefusal() async throws {
        let transport = ScriptedReplyTransport()
        transport.script([APIError.network(underlying: URLError(.networkConnectionLost)),
                          serverError(503, "bridge_offline", Self.noBridge)])
        let store = LetterReplyStore(transport: transport)
        _ = await store.send(letterId: "lt-a", text: "Lost, then refused.")
        let id = try XCTUnwrap(store.pendingReplies(for: "lt-a").first?.id)
        _ = await store.retry(letterId: "lt-a", clientId: id)
        XCTAssertEqual(transport.calls.map(\.clientId), [id, id])
        XCTAssertTrue(store.pendingReplies(for: "lt-a")[0].mayHaveArrived,
                      "a later refusal does not prove the first attempt never landed")
    }

    func testWhatEachFailureMeans() {
        let cases: [(Error, String, Bool)] = [
            (APIError.network(underlying: URLError(.timedOut)), "The server did not answer in time.", true),
            (APIError.network(underlying: URLError(.networkConnectionLost)), "The connection dropped before Walnut answered.", true),
            (APIError.network(underlying: URLError(.cannotConnectToHost)), "Walnut could not be reached.", false),
            (APIError.network(underlying: URLError(.notConnectedToInternet)), "Walnut could not be reached.", false),
            (APIError.badResponse, "Walnut's answer could not be read.", true),
            (APIError.cancelled, "The request stopped before Walnut answered.", true),
            (APIError.rateLimited, "Too many requests. Try again in a moment.", false),
            (serverError(503, "bridge_offline", Self.noBridge),
             "Your Mac is not connected to Walnut right now. Your reply is kept here; Retry when it is back.", false),
            (serverError(503, "bridge_offline", "Your primary box (Mac) has been unreachable for 9 minutes. It may be asleep (open the lid) or offline."),
             "Your Mac is not connected to Walnut right now. Your reply is kept here; Retry when it is back.", false),
            // The relayed request went out, then timed out: the Mac may have it.
            (serverError(503, "bridge_offline", "bridge request timed out after 15000ms"),
             "Your Mac is not connected to Walnut right now. Your reply is kept here; Retry when it is back.", true),
            // The route's own deadline: its message is for the log, and the
            // server may have threaded the reply before it gave up waiting.
            (serverError(504, "timeout", "POST /human-inbox/:id/human-reply did not finish in 12000ms. Try again."),
             "The server did not answer in time.", true),
            (serverError(500, "internal", "Something broke"), "Something broke.", true),
            (serverError(400, "bad_request", "text is required"), "text is required.", false),
        ]
        for (error, sentence, mayHaveArrived) in cases {
            let failure = LetterReplyStore.failure(error)
            XCTAssertEqual(failure.sentence, sentence, "\(error)")
            XCTAssertEqual(failure.mayHaveArrived, mayHaveArrived, "\(error)")
            XCTAssertFalse(sentence.contains("\u{2014}") || sentence.contains("\u{2013}"), sentence)
        }
    }

    // MARK: - Saved across a relaunch

    private func freshDefaults(_ name: String = #function) -> UserDefaults {
        let suite = "walnut.tests.letterReplies.\(name)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    func testADraftAndARefusedReplySurviveARelaunch() async throws {
        let defaults = freshDefaults()
        let transport = ScriptedReplyTransport()
        transport.script([serverError(503, "bridge_offline", Self.noBridge)])
        let first = LetterReplyStore(transport: transport, defaults: defaults)
        _ = await first.send(letterId: "lt-a", text: "Refused \u{7136}\u{540E}\u{544A}\u{8BC9}\u{6211}")
        first.setDraft("Half a second thought", for: "lt-a")
        first.setDraft("Something for B", for: "lt-b")
        first.suspendForBackground()
        let refused = try XCTUnwrap(first.pendingReplies(for: "lt-a").first)

        let relaunched = LetterReplyStore(transport: ScriptedReplyTransport(), defaults: defaults)
        XCTAssertEqual(relaunched.draft(for: "lt-a"), "Half a second thought")
        XCTAssertEqual(relaunched.draft(for: "lt-b"), "Something for B")
        XCTAssertEqual(relaunched.pendingReplies(for: "lt-a"), [refused], "the refused reply comes back with its id")

        // Once the server has it, nothing is left to restore.
        let letter = try JSONDecoder().decode(Letter.self, from: Data("""
        { "id": "lt-a", "subject": "S", "type": "review",
          "thread": [ { "from": "human", "text": "Refused", "at": 1, "clientId": "\(refused.id)" } ] }
        """.utf8))
        relaunched.reconcile(letterId: "lt-a", with: letter, readStartedAt: Date())
        relaunched.forget(letterId: "lt-b")
        let again = LetterReplyStore(transport: ScriptedReplyTransport(), defaults: defaults)
        XCTAssertTrue(again.pendingReplies(for: "lt-a").isEmpty)
        XCTAssertEqual(again.draft(for: "lt-b"), "", "a letter the server lost keeps nothing")
        XCTAssertEqual(again.draft(for: "lt-a"), "Half a second thought")
    }

    func testAReplyStillSendingWhenTheAppDiedComesBackUnconfirmed() async throws {
        let defaults = freshDefaults()
        let transport = ScriptedReplyTransport()
        let gate = CheckedContinuationGate()
        transport.gate = gate
        let store = LetterReplyStore(transport: transport, defaults: defaults)
        let sending = Task { await store.send(letterId: "lt-a", text: "In flight at the kill.") }
        for _ in 0..<200 where transport.calls.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }

        let relaunched = LetterReplyStore(transport: ScriptedReplyTransport(), defaults: defaults)
        let reply = try XCTUnwrap(relaunched.pendingReplies(for: "lt-a").first)
        XCTAssertEqual(reply.text, "In flight at the kill.")
        XCTAssertTrue(reply.mayHaveArrived, "it may have reached the server before the app died")
        if case .failed = reply.state {} else { XCTFail("a restored reply is not on its way: \(reply.state)") }
        gate.open()
        _ = await sending.value
    }

    func testSavedWordsAreCappedAndAgedOut() {
        let now = Date(timeIntervalSince1970: 1_900_000_000)
        var drafts: [String: String] = [:]
        var times: [String: Date] = [:]
        for i in 0..<(LetterReplyStore.maxLetters + 5) {
            drafts["lt-\(i)"] = "draft \(i)"
            times["lt-\(i)"] = now.addingTimeInterval(TimeInterval(-i * 60))
        }
        drafts["lt-old"] = "a month and a day old"
        times["lt-old"] = now.addingTimeInterval(-(LetterReplyStore.maxAge + 86_400))
        drafts["lt-long"] = String(repeating: "x", count: LetterReplyStore.maxTextLength + 500)
        times["lt-long"] = now
        let saved = LetterReplyStore.saved(drafts: drafts, draftTimes: times, pending: [:], now: now)
        XCTAssertEqual(saved.drafts.count, LetterReplyStore.maxLetters)
        XCTAssertNil(saved.drafts["lt-old"])
        XCTAssertNotNil(saved.drafts["lt-0"], "the newest are kept")
        XCTAssertNil(saved.drafts["lt-\(LetterReplyStore.maxLetters + 4)"], "the oldest go first")
        XCTAssertEqual(saved.drafts["lt-long"]?.text.count, LetterReplyStore.maxTextLength)
    }

    func testTheResetArgumentStartsEmpty() {
        let defaults = freshDefaults()
        let store = LetterReplyStore(transport: ScriptedReplyTransport(), defaults: defaults)
        store.setDraft("kept", for: "lt-a")
        store.suspendForBackground()
        defaults.set(true, forKey: LetterReplyStore.resetArgument)
        XCTAssertEqual(LetterReplyStore(transport: ScriptedReplyTransport(), defaults: defaults).draft(for: "lt-a"), "")
    }

    func testDraftsBelongToTheirLetterAndSurviveLeavingIt() {
        let store = LetterReplyStore(transport: ScriptedReplyTransport())
        store.setDraft("half a reply to A", for: "lt-a")
        store.setDraft("something for B", for: "lt-b")
        XCTAssertEqual(store.draft(for: "lt-a"), "half a reply to A")
        XCTAssertEqual(store.draft(for: "lt-b"), "something for B")
        store.setDraft("", for: "lt-b")
        XCTAssertEqual(store.draft(for: "lt-b"), "")
        XCTAssertEqual(store.draft(for: "lt-a"), "half a reply to A")
    }

    func testATranscriptIsAppendedAfterTheTextWithOneSpace() {
        let store = LetterReplyStore(transport: ScriptedReplyTransport())
        store.appendToDraft("  hello there ", for: "lt-a")
        XCTAssertEqual(store.draft(for: "lt-a"), "hello there")
        store.appendToDraft("\u{7136}\u{540E}\u{628A}\u{7ED3}\u{679C}\u{53D1}\u{7ED9}\u{6211}", for: "lt-a")
        XCTAssertEqual(store.draft(for: "lt-a"), "hello there \u{7136}\u{540E}\u{628A}\u{7ED3}\u{679C}\u{53D1}\u{7ED9}\u{6211}")
        store.setDraft("ends with a newline\n", for: "lt-a")
        store.appendToDraft("next", for: "lt-a")
        XCTAssertEqual(store.draft(for: "lt-a"), "ends with a newline\nnext")
        store.appendToDraft("   ", for: "lt-a")
        XCTAssertEqual(store.draft(for: "lt-a"), "ends with a newline\nnext", "an empty transcript changes nothing")
    }

    func testReconcileDropsAPendingReplyTheServerRecorded() async throws {
        let transport = ScriptedReplyTransport()
        transport.script([APIError.network(underlying: URLError(.timedOut))])
        let store = LetterReplyStore(transport: transport)
        _ = await store.send(letterId: "lt-a", text: "Recorded, response lost.")
        let id = try XCTUnwrap(store.pendingReplies(for: "lt-a").first?.id)

        let letter = try JSONDecoder().decode(Letter.self, from: Data("""
        { "id": "lt-a", "subject": "S", "type": "review",
          "thread": [ { "from": "human", "text": "Recorded, response lost.", "at": 1, "clientId": "\(id)",
                        "delivery": { "status": "queued", "sessionId": "sess-1", "at": 2 } } ] }
        """.utf8))
        store.reconcile(letterId: "lt-a", with: letter)
        XCTAssertTrue(store.pendingReplies(for: "lt-a").isEmpty, "the recorded turn replaces the failed bubble")
    }

    func testAnOlderServerStillGetsAStatusFromTheResponse() async throws {
        let transport = ScriptedReplyTransport()
        transport.recordsDelivery = false
        let store = LetterReplyStore(transport: transport)
        let sent = await store.send(letterId: "lt-a", text: "Old server.")
        let result = try XCTUnwrap(sent)
        let turn = try XCTUnwrap(result.letter?.threadEntries.first)
        XCTAssertNil(turn.delivery)
        XCTAssertEqual(store.delivery(letterId: "lt-a", entry: turn)?.status, "queued")
    }

    func testTheClientIdFitsTheServersShape() throws {
        let id = LetterReplyStore.newClientId()
        // Same rule as CLIENT_ID_RE in src/core/human-inbox/normalize.ts.
        let regex = try NSRegularExpression(pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$")
        XCTAssertEqual(regex.numberOfMatches(in: id, range: NSRange(id.startIndex..., in: id)), 1, id)
        XCTAssertNotEqual(id, LetterReplyStore.newClientId())
    }

    func testAnEchoIsOnlyEverWordsThatWereSent() {
        XCTAssertTrue(LetterReplyFieldController.isEcho("ni hao", of: "\u{4F60}\u{597D} nihao"))
        XCTAssertTrue(LetterReplyFieldController.isEcho("\u{7136}\u{540E}\u{628A}\u{7ED3}\u{679C}\u{53D1}\u{7ED9}\u{6211}", of: "and please \u{7136}\u{540E}\u{628A}\u{7ED3}\u{679C}\u{53D1}\u{7ED9}\u{6211}"))
        XCTAssertFalse(LetterReplyFieldController.isEcho("a new thought", of: "the old reply"),
                       "words the human did not send must never be dropped")
        XCTAssertFalse(LetterReplyFieldController.isEcho("", of: "x"))
    }

    // MARK: - A delivery still running (2026-09-29 gate, P1-A)

    private func turn(_ json: String) throws -> LetterThreadEntry {
        try JSONDecoder().decode(LetterThreadEntry.self, from: Data(json.utf8))
    }

    func testATurnWaitsForItsDeliveryOnlyWhenTheOutcomeIsStillToCome() throws {
        let store = LetterReplyStore(transport: ScriptedReplyTransport())
        let pending = try turn(#"{ "from": "human", "text": "a", "at": 1, "clientId": "rp-1", "delivery": { "status": "pending", "at": 1 } }"#)
        let noOutcomeYet = try turn(#"{ "from": "human", "text": "b", "at": 2, "clientId": "rp-2" }"#)
        let answerPending = try turn(#"{ "from": "human", "text": "Go", "at": 3, "delivery": { "status": "pending", "at": 3 } }"#)
        let queued = try turn(#"{ "from": "human", "text": "c", "at": 4, "clientId": "rp-4", "delivery": { "status": "queued", "at": 5 } }"#)
        let oldServer = try turn(#"{ "from": "human", "text": "d", "at": 6 }"#)
        let agent = try turn(#"{ "from": "agent", "text": "e", "at": 7 }"#)
        XCTAssertTrue(store.awaitsDelivery(letterId: "lt-a", entry: pending))
        XCTAssertTrue(store.awaitsDelivery(letterId: "lt-a", entry: noOutcomeYet),
                      "a reply with an id and no outcome is mid-delivery on a server that writes it afterwards")
        XCTAssertTrue(store.awaitsDelivery(letterId: "lt-a", entry: answerPending))
        XCTAssertFalse(store.awaitsDelivery(letterId: "lt-a", entry: queued))
        XCTAssertFalse(store.awaitsDelivery(letterId: "lt-a", entry: oldServer), "an older server's turn has nothing to wait for")
        XCTAssertFalse(store.awaitsDelivery(letterId: "lt-a", entry: agent))

        store.markDeliveryUnconfirmed(letterId: "lt-a", entries: [pending])
        XCTAssertTrue(store.isDeliveryUnconfirmed(letterId: "lt-a", entry: pending))
        XCTAssertFalse(store.isDeliveryUnconfirmed(letterId: "lt-b", entry: pending), "marks belong to their letter")
        store.forget(letterId: "lt-a")
        XCTAssertFalse(store.isDeliveryUnconfirmed(letterId: "lt-a", entry: pending))
    }

    /// r4 P2-4: a turn given up on whose outcome lands later is settled by the
    /// read that brings it: no longer waiting, and its "Not confirmed" mark gone.
    func testALateOutcomeSettlesATurnGivenUpOn() throws {
        let store = LetterReplyStore(transport: ScriptedReplyTransport())
        let waiting = try turn(#"{ "from": "human", "text": "a", "at": 1, "clientId": "rp-1", "delivery": { "status": "pending", "at": 1 } }"#)
        store.markDeliveryUnconfirmed(letterId: "lt-a", entries: [waiting])
        let late = try JSONDecoder().decode(Letter.self, from: Data("""
        { "id": "lt-a", "subject": "S", "type": "review",
          "thread": [ { "from": "human", "text": "a", "at": 1, "clientId": "rp-1",
                        "delivery": { "status": "queued", "sessionId": "sess-1", "at": 9 } } ] }
        """.utf8))
        store.reconcile(letterId: "lt-a", with: late, readStartedAt: Date())
        let settled = try XCTUnwrap(late.threadEntries.first)
        XCTAssertFalse(store.awaitsDelivery(letterId: "lt-a", entry: settled))
        XCTAssertFalse(store.isDeliveryUnconfirmed(letterId: "lt-a", entry: settled))
    }

    func testA202PendingAnswerRemovesTheBubbleAndLeavesTheTurnWaiting() async throws {
        let transport = ScriptedReplyTransport()
        transport.deliveryStatus = "pending"
        let store = LetterReplyStore(transport: transport)
        let sent = await store.send(letterId: "lt-a", text: "Slow session.")
        let result = try XCTUnwrap(sent)
        XCTAssertTrue(store.pendingReplies(for: "lt-a").isEmpty, "the turn is on record, so it shows once, as the turn")
        let entry = try XCTUnwrap(result.letter?.threadEntries.first)
        XCTAssertTrue(store.awaitsDelivery(letterId: "lt-a", entry: entry))
        XCTAssertEqual(store.delivery(letterId: "lt-a", entry: entry)?.status, "pending",
                       "a pending answer is never taken as the outcome")
    }

    func testARetryOfARecordedTurnSettlesItsNotConfirmedMarkOnlyWhenItAnswers() async throws {
        let transport = ScriptedReplyTransport()
        let gate = CheckedContinuationGate()
        transport.gate = gate
        let store = LetterReplyStore(transport: transport)
        let entry = try turn(#"{ "from": "human", "text": "again", "at": 1, "clientId": "rp-9", "delivery": { "status": "pending", "at": 1 } }"#)
        store.markDeliveryUnconfirmed(letterId: "lt-a", entries: [entry])
        let retrying = Task { await store.retryRecordedTurn(letterId: "lt-a", entry: entry) }
        await waitUntil { !transport.calls.isEmpty }
        XCTAssertTrue(store.isRetrying(letterId: "lt-a", entry: entry))
        XCTAssertTrue(store.isDeliveryUnconfirmed(letterId: "lt-a", entry: entry),
                      "the line keeps what it said until the Retry is answered")
        gate.open()
        _ = await retrying.value
        XCTAssertFalse(store.isDeliveryUnconfirmed(letterId: "lt-a", entry: entry))
        XCTAssertEqual(transport.calls.map(\.clientId), ["rp-9"])
    }

    /// r4 P1: a Retry of a refused reply is a new send. At the tap, before any
    /// answer, it moves after the other pending replies with the turns on
    /// record now and the resend time, and reads as on its way; a second tap
    /// sends nothing.
    func testARetryOfARefusedReplyIsANewSendThatMovesLast() async throws {
        let transport = ScriptedReplyTransport()
        // Both sends and the Retry are refused (past the script, a call succeeds).
        let refused = serverError(503, "bridge_offline", Self.noBridge)
        transport.script([refused, refused, refused])
        let store = LetterReplyStore(transport: transport)
        _ = await store.send(letterId: "lt-a", text: "Refused, then retried.", afterTurns: 1)
        let old = try XCTUnwrap(store.pendingReplies(for: "lt-a").first)
        _ = await store.send(letterId: "lt-a", text: "Refused too, sent later.", afterTurns: 1)
        let sentAt = old.createdAt

        let gate = CheckedContinuationGate()
        transport.gate = gate
        XCTAssertTrue(store.beginRetry(letterId: "lt-a", clientId: old.id, afterTurns: 4))
        let moved = try XCTUnwrap(store.pendingReplies(for: "lt-a").last)
        XCTAssertEqual(moved.id, old.id, "the retried reply is not last")
        XCTAssertEqual(moved.state, .sending)
        XCTAssertEqual(moved.afterTurns, 4, "it goes after everything on record at the Retry")
        XCTAssertGreaterThan(moved.createdAt, sentAt, "its bubble shows the resend time")
        XCTAssertFalse(store.beginRetry(letterId: "lt-a", clientId: old.id), "a second tap is the same Retry")

        let delivering = Task { await store.deliver(letterId: "lt-a", clientId: old.id) }
        await waitUntil { transport.calls.count == 3 }
        let secondTap = await store.retry(letterId: "lt-a", clientId: old.id)
        XCTAssertNil(secondTap, "a tap while it is on its way sends nothing")
        gate.open()
        _ = await delivering.value
        XCTAssertEqual(transport.calls.count, 3)
        XCTAssertEqual(store.pendingReplies(for: "lt-a").map(\.id).last, old.id, "refused again, it stays where it moved")
    }

    /// A reply that may already be on record keeps its slot on Retry: if the
    /// server has it, that is where it is.
    func testARetryOfAReplyThatMayHaveArrivedKeepsItsSlot() async throws {
        let transport = ScriptedReplyTransport()
        transport.script([APIError.network(underlying: URLError(.timedOut)), serverError(503, "bridge_offline", Self.noBridge)])
        let store = LetterReplyStore(transport: transport)
        _ = await store.send(letterId: "lt-a", text: "Maybe on record.", afterTurns: 1)
        _ = await store.send(letterId: "lt-a", text: "Refused after it.", afterTurns: 1)
        let unsure = try XCTUnwrap(store.pendingReplies(for: "lt-a").first)
        XCTAssertTrue(unsure.mayHaveArrived)
        XCTAssertTrue(store.beginRetry(letterId: "lt-a", clientId: unsure.id, afterTurns: 5))
        let kept = try XCTUnwrap(store.pendingReplies(for: "lt-a").first)
        XCTAssertEqual(kept.id, unsure.id)
        XCTAssertEqual(kept.afterTurns, 1)
        XCTAssertEqual(kept.createdAt, unsure.createdAt)
        XCTAssertEqual(kept.state, .sending)
    }

    func testBeginSendPutsTheReplyInTheThreadBeforeAnyNetwork() {
        let transport = ScriptedReplyTransport()
        let store = LetterReplyStore(transport: transport)
        store.setDraft("Now.", for: "lt-a")
        let id = store.beginSend(letterId: "lt-a", text: "Now.")
        XCTAssertNotNil(id)
        XCTAssertEqual(store.pendingReplies(for: "lt-a").map(\.id), [id].compactMap { $0 })
        XCTAssertEqual(store.draft(for: "lt-a"), "")
        XCTAssertTrue(transport.calls.isEmpty)
        XCTAssertNil(store.beginSend(letterId: "lt-a", text: "   "))
    }

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<200 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
    }
}

/// One thread list in SEND order (2026-09-29 gate P1-B; r4 gate P1 and P2-1).
final class LetterThreadOrderTests: XCTestCase {
    private func turn(_ from: String, _ text: String, at: Double, clientId: String? = nil) throws -> LetterThreadEntry {
        let id = clientId.map { #", "clientId": "\#($0)""# } ?? ""
        return try JSONDecoder().decode(LetterThreadEntry.self, from: Data(#"{ "from": "\#(from)", "text": "\#(text)", "at": \#(at)\#(id) }"#.utf8))
    }

    private func pending(_ id: String, at ms: Double, after: Int? = nil) -> LetterReplyStore.PendingReply {
        .init(id: id, text: id, createdAt: Date(timeIntervalSince1970: ms / 1000), state: .failed("x"), afterTurns: after)
    }

    func testAReplySentAfterARefusedOneComesAfterIt() throws {
        let entries = [
            try turn("agent", "question", at: 1_000),
            try turn("human", "newer", at: 3_000, clientId: "rp-new"),
        ]
        let items = LetterThreadItem.ordered(entries: entries, pending: [pending("rp-old", at: 2_000, after: 1)])
        XCTAssertEqual(items.map(\.id), ["turn-agent|1000.0|", "reply-rp-old", "reply-rp-new"])
    }

    /// The server's clock 10s behind or ahead of the phone's: the new reply is
    /// recorded at a time before (or long after) the refused one was sent. The
    /// order is the order they were sent in, either way.
    func testTheOrderDoesNotDependOnEitherClock() throws {
        let agent = try turn("agent", "question", at: 1_000_000)
        let refused = pending("rp-old", at: 1_050_000, after: 1)
        for skew in [-10_000.0, 10_000.0, -600_000.0] {
            let recordedAt = 1_053_000 + skew
            let items = LetterThreadItem.ordered(
                entries: [agent, try turn("human", "newer", at: recordedAt, clientId: "rp-new")], pending: [refused]
            )
            XCTAssertEqual(items.map(\.id), ["turn-agent|1000000.0|", "reply-rp-old", "reply-rp-new"], "skew \(skew)")
        }
    }

    /// A reply keeps its row id AND its slot when it goes from pending to
    /// recorded, even though the server records it at a time of its own (the
    /// old version of this test pinned equal times, which is how it missed the
    /// jump, r4 gate P1).
    func testARecordedReplyKeepsTheIdAndTheSlotItHadWhilePending() throws {
        let agent = try turn("agent", "question", at: 1_000)
        let earlier = try turn("human", "earlier", at: 2_000, clientId: "rp-earlier")
        let refused = pending("rp-old", at: 3_000, after: 2)
        let waiting = LetterThreadItem.ordered(
            entries: [agent, earlier], pending: [refused, pending("rp-1", at: 5_000, after: 2)]
        )
        // Recorded with the server 10s behind: its time is the oldest in the thread.
        let recorded = LetterThreadItem.ordered(
            entries: [agent, earlier, try turn("human", "x", at: -5_000, clientId: "rp-1")], pending: [refused]
        )
        XCTAssertEqual(waiting.map(\.id), recorded.map(\.id), "the reply would move, or be a new row, when it settles")
        XCTAssertEqual(recorded.map(\.id).last, "reply-rp-1")
    }

    /// A Retry of the oldest refused reply puts it last (the store moves it and
    /// re-slots it), and once the server records it there, it stays last.
    func testARetriedRefusedReplyIsLastBeforeAndAfterItIsRecorded() throws {
        let agent = try turn("agent", "question", at: 1_000)
        let newer = (1...3).map { n in try! turn("human", "newer \(n)", at: 2_000 + Double(n), clientId: "rp-n\(n)") }
        let retried = pending("rp-old", at: 9_000, after: 4)
        let sending = LetterThreadItem.ordered(entries: [agent] + newer, pending: [retried])
        XCTAssertEqual(sending.map(\.id).last, "reply-rp-old")
        let recorded = LetterThreadItem.ordered(
            entries: [agent] + newer + [try turn("human", "old", at: 9_100, clientId: "rp-old")], pending: []
        )
        XCTAssertEqual(sending.map(\.id), recorded.map(\.id))
    }

    func testAPendingReplyAlreadyOnRecordShowsOnceAndLaterRepliesNeverGoAboveEarlierOnes() throws {
        let entries = [try turn("human", "x", at: 5_000, clientId: "rp-1"), try turn("agent", "y", at: 6_000)]
        let items = LetterThreadItem.ordered(
            entries: entries,
            pending: [pending("rp-0", at: 100, after: 0), pending("rp-1", at: 5_000, after: 0),
                      pending("rp-2", at: 6_000, after: 2), pending("rp-3", at: 7_000, after: 1)]
        )
        // rp-1 is on record, so it shows once, as its turn. rp-3 claims an
        // earlier slot than rp-2, which was sent before it: it goes after rp-2.
        XCTAssertEqual(items.map(\.id), ["reply-rp-0", "reply-rp-1", "turn-agent|6000.0|", "reply-rp-2", "reply-rp-3"])
        XCTAssertEqual(items.filter(\.isHuman).count, 4)
    }

    /// The row a Retry moves is found, so it can be drawn lifted while it moves
    /// (build 84 gate, P3); a row that only came or went is no move.
    func testTheRowARetryMovesDownIsFound() {
        let moved = LetterThreadItem.movedDown
        XCTAssertEqual(moved(["a", "r", "b", "c"], ["a", "b", "c", "r"]), "r")
        XCTAssertEqual(moved(["r", "a"], ["a", "r"]), "r", "a swap of two: the one now lower moved")
        XCTAssertNil(moved(["a", "b"], ["a", "b", "c"]), "a new reply at the end")
        XCTAssertNil(moved(["a", "r", "b"], ["a", "b"]), "a reply that went")
        XCTAssertNil(moved(["a", "b"], ["a", "b"]))
        XCTAssertEqual(moved(["a", "r", "b"], ["a", "b", "r", "new"]), "r", "a move and a new row together")
        XCTAssertNil(moved(["a", "b", "c", "d"], ["b", "a", "d", "c"]), "two moves are not one row moving")
    }

    /// A reply saved before `afterTurns` existed is slotted by its send time.
    func testAReplySavedBeforeSlotsIsPlacedByItsTime() throws {
        let entries = [try turn("agent", "a", at: 1_000), try turn("agent", "b", at: 3_000)]
        let items = LetterThreadItem.ordered(entries: entries, pending: [pending("rp-legacy", at: 2_000)])
        XCTAssertEqual(items.map(\.id), ["turn-agent|1000.0|", "reply-rp-legacy", "turn-agent|3000.0|"])
    }
}

/// The voice notices' words (2026-09-29 gate, P2-2).
final class VoiceNoticeCopyTests: XCTestCase {
    func testAFailedTranscriptionAndItsSavedTakeAreOneNotice() {
        let one = VoiceNoticeCopy.savedTake(
            error: "Voice unavailable: No speech engine is reachable right now. Recording saved.", count: 1
        )
        XCTAssertEqual(one.full, "Voice unavailable: No speech engine is reachable right now. Recording saved.")
        XCTAssertEqual(one.short, "Saved, not transcribed.")
        let two = VoiceNoticeCopy.savedTake(error: "Recording stopped unexpectedly. Saved for retry.", count: 2)
        XCTAssertEqual(two.full, "Recording stopped unexpectedly. 2 recordings saved.")
        XCTAssertEqual(two.short, "2 saved, not transcribed.")
        XCTAssertNil(VoiceNoticeCopy.savedCore("Recording too short"), "an error that saved nothing stands alone")
    }

    /// A take the recorder gave up on and its "couldn't be transcribed" row are one
    /// notice (r5 gate follow-up): the sentence said it, then the row said it again.
    func testATakeTheRecorderGaveUpOnAndItsRowAreOneNotice() {
        let gaveUp = "Couldn't transcribe that recording. Discard it or keep it for later."
        let one = VoiceNoticeCopy.retiredTake(error: gaveUp, count: 1)
        XCTAssertEqual(one.full, gaveUp)
        XCTAssertEqual(one.short, "Could not transcribe.")
        let two = VoiceNoticeCopy.retiredTake(error: gaveUp, count: 2)
        // One sentence for both takes: "Couldn't transcribe that recording. 2
        // recordings kept." read as one take kept twice (build 84 gate, P3).
        XCTAssertEqual(two.full, "Couldn't transcribe 2 recordings. They are kept.",
                       "a sentence about one take says how many the Discard clears")
        XCTAssertEqual(two.short, "2 could not be transcribed.")
        // The plain row the merged notice leaves when dismissed does not read
        // the same at the accessibility sizes (build 84 gate, P2).
        XCTAssertEqual(VoiceNoticeCopy.failed(count: 1).short, "1 recording not transcribed.")
        XCTAssertEqual(VoiceNoticeCopy.failed(count: 2).short, "2 recordings not transcribed.")
        for count in [1, 2, 12] {
            XCTAssertNotEqual(VoiceNoticeCopy.failed(count: count).short,
                              VoiceNoticeCopy.retiredTake(error: gaveUp, count: count).short, "count \(count)")
        }
        let counted = "2 recordings couldn't be transcribed. Discard to clear them."
        XCTAssertEqual(VoiceNoticeCopy.retiredTake(error: counted, count: 2).full, counted,
                       "a sentence that already gives the count stands as it is")
        let damaged = "That recording is damaged and can't be transcribed. Discard it."
        XCTAssertEqual(VoiceNoticeCopy.retiredTake(error: damaged, count: 1).full, damaged)

        // Which row an error rides on.
        let home = VoiceNoticeRows.errorHome
        XCTAssertEqual(home(gaveUp, false, true), .retiredTake)
        XCTAssertEqual(home(gaveUp, true, true), .retiredTake, "a waiting take elsewhere keeps its own row")
        XCTAssertEqual(home(gaveUp, false, false), .alone, "no given-up row to join")
        XCTAssertEqual(home("No speech recognized. Recording kept.", true, true), .savedTake)
        XCTAssertEqual(home("No speech recognized. Recording kept.", false, true), .alone)
        XCTAssertEqual(home("Recording too short", true, true), .alone)
        XCTAssertEqual(home(VoiceRecorder.microphoneDeniedMessage, true, true), .alone)
        for saved in VoiceNoticeCopy.savedSuffixes {
            XCTAssertNil(VoiceNoticeCopy.retiredCore("Something failed.\(saved)"), "a saved take read as given up")
        }
    }

    /// The notice's buttons wrap onto a new line rather than run past the screen:
    /// at the largest text size "Open Settings" and the dismiss beside it were
    /// 425pt on a 402pt screen (build 84 gate, P2).
    func testTheNoticeButtonsWrapToTheWidthOffered() {
        let settings = CGSize(width: 330, height: 60), dismiss = CGSize(width: 44, height: 44)
        let wide = WrappingRow.lines(fitting: 402, sizes: [settings, dismiss], spacing: 8)
        XCTAssertEqual(wide.map(\.indices), [[0, 1]])
        XCTAssertEqual(wide.first?.width, 382)
        XCTAssertEqual(wide.first?.height, 60)
        let narrow = WrappingRow.lines(fitting: 370, sizes: [settings, dismiss], spacing: 8)
        XCTAssertEqual(narrow.map(\.indices), [[0], [1]])
        XCTAssertTrue(narrow.allSatisfy { $0.width <= 370 })
        let three = WrappingRow.lines(fitting: 200, sizes: Array(repeating: CGSize(width: 60, height: 44), count: 3), spacing: 8)
        XCTAssertEqual(three.map(\.indices), [[0, 1, 2]], "196pt fits in 200")
        XCTAssertTrue(WrappingRow.lines(fitting: 100, sizes: [], spacing: 8).isEmpty)
    }

    func testTheShortFormsAreOneShortSentence() {
        XCTAssertEqual(VoiceNoticeCopy.error(VoiceRecorder.microphoneDeniedMessage).short, "Microphone is off.")
        XCTAssertEqual(VoiceNoticeCopy.error(VoiceRecorder.microphoneDeniedMessage).full, VoiceRecorder.microphoneDeniedMessage)
        XCTAssertEqual(VoiceNoticeCopy.error("Another upload is in progress. Try again in a moment.").short,
                       "Another upload is in progress.")
        XCTAssertEqual(VoiceNoticeCopy.error("Recording too short").short, "Recording too short")
        XCTAssertEqual(VoiceNoticeCopy.pending(count: 1).full, "1 recording saved. Transcription is pending.")
        let all = [
            VoiceNoticeCopy.pending(count: 1), .pending(count: 3), .failed(count: 1), .failed(count: 2),
            .error(VoiceRecorder.microphoneDeniedMessage), .savedTake(error: "x. Recording kept.", count: 1),
            .retiredTake(error: "x. Discard it.", count: 1), .retiredTake(error: "x. Discard it.", count: 12),
            .failed(count: 12),
        ]
        for copy in all {
            for text in [copy.full, copy.short] {
                XCTAssertFalse(text.contains("\u{2014}") || text.contains("\u{2013}"), "a dash in: \(text)")
            }
            XCTAssertLessThanOrEqual(copy.short.count, 32, "not short: \(copy.short)")
            XCTAssertLessThanOrEqual(copy.short.filter { $0 == "." }.count, 1, "more than one sentence: \(copy.short)")
        }
    }
}

final class LetterReplyStatusTests: XCTestCase {
    private let calendar = Calendar(identifier: .gregorian)
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func delivery(_ status: String, reason: String? = nil, session: String? = "sess-1") -> LetterDelivery {
        LetterDelivery(status: status, reason: reason, sessionId: session, messageId: nil)
    }

    private func status(_ d: LetterDelivery, at: Date? = nil, canRetry: Bool = true) -> LetterReplyStatus {
        .recorded(d, recipient: "Promotion check-in", at: at ?? now, canRetry: canRetry, now: now, calendar: calendar)
    }

    private var time: String { LetterReplyStatus.timeLabel(now, now: now, calendar: calendar) }

    func testQueuedNamesTheRecipientAndTheTimeAndOpensTheSession() {
        let s = status(delivery("queued"))
        XCTAssertEqual(s.text, "Sent to Promotion check-in · \(time)")
        XCTAssertEqual(s.sessionId, "sess-1")
        XCTAssertEqual(s.tone, .settled)
        XCTAssertFalse(s.offersRetry)
    }

    func testDeferredSaysItWaitsOnAPermissionPrompt() {
        let s = status(delivery("deferred", reason: "origin_awaiting_permission"))
        XCTAssertEqual(s.text, "Queued for Promotion check-in · \(time). It is waiting on a permission prompt, and your reply reaches it after that.")
        XCTAssertEqual(s.sessionId, "sess-1")
        XCTAssertEqual(s.tone, .waiting)
    }

    func testSkippedSaysSavedAndThatNothingWasSent() {
        let gone = status(delivery("skipped", reason: "origin_session_gone"))
        XCTAssertEqual(gone.text, "Saved · \(time). The agent that wrote this letter has ended, so nothing was sent.")
        XCTAssertNil(gone.sessionId, "there is no session left to open")
        let none = status(delivery("skipped", reason: "no_origin_session", session: nil))
        XCTAssertEqual(none.text, "Saved · \(time). This letter has no agent session to answer, so nothing was sent.")
    }

    func testFailedSaysNotSentAndOffersRetryOnlyWhenTheTurnCanBeRetried() {
        let s = status(delivery("failed", reason: "timeout"))
        XCTAssertEqual(s.text, "Not sent to Promotion check-in · \(time). Your reply is saved in this letter.")
        XCTAssertEqual(s.tone, .problem)
        XCTAssertTrue(s.offersRetry)
        XCTAssertFalse(status(delivery("failed"), canRetry: false).offersRetry,
                       "a turn with no client id cannot be retried without threading it twice")
    }

    func testLocalStatesAndTheUnknownStatus() {
        XCTAssertEqual(LetterReplyStatus.sending(recipient: "the agent").text, "Sending to the agent…")
        let failed = LetterReplyStatus.sendFailed("The server did not answer in time.")
        XCTAssertEqual(failed.text, "Not sent. The server did not answer in time.")
        XCTAssertTrue(failed.offersRetry)
        XCTAssertTrue(failed.offersEdit)
        XCTAssertEqual(status(delivery("invented_later")).text, "Saved · \(time)")
    }

    func testALostAnswerSaysItMayHaveArrivedAndOffersOnlyRetry() {
        let s = LetterReplyStatus.unconfirmed(recipient: "Stub work task")
        XCTAssertEqual(s.text, "Not confirmed. It may have reached Stub work task. Retry is safe, it will not send twice.")
        XCTAssertTrue(s.offersRetry)
        XCTAssertFalse(s.offersEdit, "an edited reply goes out under a new id and lands twice")
        XCTAssertNil(s.sessionId)
        // A turn with no id (a decision answer) has no safe Retry, and says only what is true.
        let noRetry = LetterReplyStatus.unconfirmed(recipient: "Stub work task", canRetry: false)
        XCTAssertEqual(noRetry.text, "Not confirmed. It may have reached Stub work task.")
        XCTAssertFalse(noRetry.offersRetry)
    }

    func testAPendingDeliveryOnRecordReadsAsSending() {
        XCTAssertEqual(status(delivery("pending")).text, "Sending to Promotion check-in…")
        XCTAssertEqual(status(delivery("pending")).tone, .waiting)
        XCTAssertFalse(status(delivery("pending")).opensSession)
    }

    /// While its Retry is on the way a line says so, "Sending to ...", never the
    /// failure above a "Sending" row (r4 gate, P2-5); it keeps the failure's
    /// words only as its size, and its button row; a failed Retry says what the
    /// line said before it.
    func testABusyLineSaysItIsSendingInTheSpaceOfItsWordsAndKeepsItsRow() {
        let failed = status(delivery("failed"))
        let busy = failed.busy(recipient: "Promotion check-in")
        XCTAssertTrue(busy.isBusy)
        XCTAssertEqual(busy.text, "Sending to Promotion check-in…")
        XCTAssertEqual(busy.tone, .waiting)
        XCTAssertEqual(busy.reservedText, failed.text, "the line would change height under the finger")
        XCTAssertTrue(busy.offersRetry, "the row stays, with progress in it")
        XCTAssertFalse(busy.opensSession)
        XCTAssertFalse(LetterReplyStatus.sending(recipient: "r").busy(recipient: "r").isBusy,
                       "a line with no row has nothing to keep")
        XCTAssertTrue(busy.withoutSession().isBusy)
        XCTAssertEqual(busy.withoutSession().reservedText, failed.text)
        let retried = LetterReplyStatus.retryFailed(
            recipient: "Promotion check-in", at: now, sessionId: "sess-1", now: now, calendar: calendar
        )
        XCTAssertEqual(retried.text, failed.text, "the failure line changed size after its Retry")
    }

    func testTheLineOpensTheSessionOnlyWhenNothingElseIsOffered() {
        XCTAssertTrue(status(delivery("queued")).opensSession)
        let failed = status(delivery("failed"))
        XCTAssertEqual(failed.sessionId, "sess-1")
        XCTAssertFalse(failed.opensSession, "a near miss on Retry must not open the session")
        XCTAssertFalse(status(delivery("queued")).withoutSession().opensSession)
    }

    func testSkippedHasItsOwnToneNeverTheSuccessOne() {
        XCTAssertEqual(status(delivery("skipped", reason: "origin_session_gone")).tone, .held)
        XCTAssertEqual(status(delivery("invented_later")).tone, .held)
        XCTAssertEqual(status(delivery("queued")).tone, .settled)
    }

    func testNoCopyUsesADash() {
        let all: [LetterReplyStatus] = [
            .unconfirmed(recipient: "the agent"),
            status(delivery("queued")), status(delivery("deferred")),
            status(delivery("skipped", reason: "origin_session_gone")),
            status(delivery("skipped", reason: "no_origin_session")), status(delivery("skipped")),
            status(delivery("failed")), status(delivery("x")),
            .sending(recipient: "the agent"), .sendFailed("x."),
            .retryFailed(recipient: "r", at: now, sessionId: nil, now: now, calendar: calendar),
            .unconfirmed(recipient: "r", canRetry: false), status(delivery("pending")),
        ]
        let humanTexts = ["queued", "deferred", "skipped", "failed", "x"].flatMap { s in
            ["no_origin_session", "origin_session_gone", nil].map { delivery(s, reason: $0).humanText }
        }
        for text in all.map(\.text) + humanTexts {
            XCTAssertFalse(text.contains("\u{2014}") || text.contains("\u{2013}"), "a dash in: \(text)")
        }
    }

    func testTheRecipientIsTheStoreTitleThenTheStampedTitleThenTheAgent() {
        XCTAssertEqual(LetterReplyStatus.recipientName(storeTitle: "Stub work task", stampedTitle: "Promotion check-in"),
                       "Stub work task")
        XCTAssertEqual(LetterReplyStatus.recipientName(storeTitle: nil, stampedTitle: "Promotion check-in"),
                       "Promotion check-in")
        XCTAssertEqual(LetterReplyStatus.recipientName(storeTitle: "  ", stampedTitle: nil), "the agent")
        let long = String(repeating: "word ", count: 40)
        XCTAssertLessThanOrEqual(LetterReplyStatus.recipientName(storeTitle: long, stampedTitle: nil).count,
                                 LetterReplyStatus.recipientLimit + 1)
    }

    func testTheTimeIsJustTheTimeTodayAndCarriesTheDateOtherwise() {
        let today = LetterReplyStatus.timeLabel(now, now: now, calendar: calendar)
        XCTAssertEqual(today, now.formatted(date: .omitted, time: .shortened))
        let yesterday = now.addingTimeInterval(-86_400 * 2)
        let other = LetterReplyStatus.timeLabel(yesterday, now: now, calendar: calendar)
        XCTAssertNotEqual(other, yesterday.formatted(date: .omitted, time: .shortened))
        XCTAssertTrue(other.contains(yesterday.formatted(.dateTime.day())), other)
    }

    func testAThreadTurnDecodesItsRecordedDelivery() throws {
        let entry = try JSONDecoder().decode(LetterThreadEntry.self, from: Data("""
        { "from": "human", "text": "hi", "at": 1800000000000, "clientId": "rp-1",
          "delivery": { "status": "deferred", "reason": "origin_awaiting_permission", "sessionId": "s", "at": 1800000000100 } }
        """.utf8))
        XCTAssertEqual(entry.clientId, "rp-1")
        XCTAssertEqual(entry.delivery?.asDelivery.status, "deferred")
        XCTAssertEqual(entry.delivery?.asDelivery.sessionId, "s")
        // An older server: neither field, and the turn still decodes.
        let old = try JSONDecoder().decode(LetterThreadEntry.self, from: Data(#"{ "from": "human", "text": "hi", "at": 1 }"#.utf8))
        XCTAssertNil(old.delivery)
        XCTAssertNil(old.clientId)
    }
}

/// The reply field's send path on a bare `UITextView` (no window, no keyboard):
/// marked text is committed and read as shown, the view itself is emptied, and
/// an input session writing the sent words back afterwards is dropped, while
/// words that were never sent are kept.
@MainActor
final class LetterReplyFieldSessionTests: XCTestCase {
    private final class Box { var text = ""; var focused = false }

    private func makeField() -> (UITextView, LetterReplyFieldController, Box) {
        let box = Box()
        let controller = LetterReplyFieldController()
        let field = LetterReplyField(
            text: Binding(get: { box.text }, set: { box.text = $0 }),
            isFocused: Binding(get: { box.focused }, set: { box.focused = $0 }),
            controller: controller
        )
        let coordinator = field.makeCoordinator()
        let view = UITextView()
        view.delegate = coordinator
        controller.attach(view, coordinator: coordinator)
        // The field holds its coordinator weakly; keep it alive for the test.
        retained.append(coordinator)
        return (view, controller, box)
    }

    private var retained: [AnyObject] = []

    override func tearDown() {
        retained.removeAll()
        super.tearDown()
    }

    /// What UIKit does after an input session changes the text: tell the delegate.
    private func sessionWrote(_ text: String, into view: UITextView) {
        view.text = text
        view.delegate?.textViewDidChange?(view)
    }

    func testMarkedTextIsCommittedAndReadAsShown() async throws {
        let (view, controller, box) = makeField()
        sessionWrote("\u{4F60}\u{597D}", into: view)
        view.selectedRange = NSRange(location: 2, length: 0)
        view.setMarkedText("ma", selectedRange: NSRange(location: 2, length: 0))
        try XCTSkipIf(view.markedTextRange == nil, "UIKit kept no marked text on a window-less text view")
        let read = await controller.commitAndRead(fallback: "")
        XCTAssertEqual(read, "\u{4F60}\u{597D}ma")
        XCTAssertNil(view.markedTextRange, "the composition is still marked after the commit")
        XCTAssertEqual(box.text, "\u{4F60}\u{597D}ma", "the draft does not hold what is sent")
    }

    /// A composition is committed and read in the same turn (no await): the
    /// settle wait kept the committed words in the field for 240ms after Send
    /// (2026-09-29 gate, P2-1).
    func testAMarkedCompositionIsReadWithoutWaiting() throws {
        let (view, controller, box) = makeField()
        sessionWrote("\u{4F60}\u{597D}", into: view)
        view.selectedRange = NSRange(location: 2, length: 0)
        view.setMarkedText("ma", selectedRange: NSRange(location: 2, length: 0))
        try XCTSkipIf(view.markedTextRange == nil, "UIKit kept no marked text on a window-less text view")
        let read = controller.readNow(fallback: "")
        XCTAssertEqual(read, "\u{4F60}\u{597D}ma")
        XCTAssertNil(view.markedTextRange)
        XCTAssertEqual(box.text, "\u{4F60}\u{597D}ma")
        XCTAssertTrue(controller.committedComposition, "the caller must end editing after a composition")
        controller.clear(sent: read ?? "")
        XCTAssertEqual(view.text, "", "the field must be empty in the same turn")
        // A read with nothing marked leaves the keyboard alone.
        sessionWrote("next", into: view)
        _ = controller.readNow(fallback: "")
        XCTAssertFalse(controller.committedComposition)
    }

    /// Nothing marked, no dictation: what is shown is final, so the send reads
    /// it at once. The old path always waited 200ms for the text to settle,
    /// and the sent words sat in the field that long.
    func testWithNothingComposingTheWordsAreReadAtOnce() async {
        let (view, controller, box) = makeField()
        sessionWrote("ready to go", into: view)
        let clock = ContinuousClock()
        let started = clock.now
        let read = await controller.commitAndRead(fallback: "")
        XCTAssertEqual(read, "ready to go")
        XCTAssertLessThan(clock.now - started, .milliseconds(100), "nothing was composing, so there is nothing to wait for")
        XCTAssertEqual(box.text, "ready to go")
    }

    func testAnEchoOfTheSentWordsIsDroppedAndNewWordsAreKept() async {
        let (view, controller, box) = makeField()
        sessionWrote("please rerun the tests \u{7136}\u{540E}\u{628A}\u{7ED3}\u{679C}\u{53D1}\u{7ED9}\u{6211}", into: view)
        let sent = await controller.commitAndRead(fallback: "")
        XCTAssertEqual(sent, "please rerun the tests \u{7136}\u{540E}\u{628A}\u{7ED3}\u{679C}\u{53D1}\u{7ED9}\u{6211}")
        controller.clear(sent: sent)
        XCTAssertEqual(view.text, "")
        XCTAssertEqual(box.text, "")

        // Dictation publishes its last hypothesis after the send.
        sessionWrote("\u{7136}\u{540E}\u{628A}\u{7ED3}\u{679C}\u{53D1}\u{7ED9}\u{6211}", into: view)
        XCTAssertEqual(view.text, "", "the sent words came back into the field")
        XCTAssertEqual(box.text, "")

        // Words that were never sent are the human's, and are never dropped.
        sessionWrote("a second thought", into: view)
        XCTAssertEqual(view.text, "a second thought")
        XCTAssertEqual(box.text, "a second thought")
    }
}
