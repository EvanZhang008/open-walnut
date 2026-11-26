import XCTest
@testable import Walnut

/// A send the server held for a Mac that is away is kept on the phone until it is known what
/// became of it; one never delivered (the companion's day ran out) comes back, not sent, where it
/// was typed (review of 2026-11-25: the words were gone with nothing saying so). The conversation
/// settles what the server no longer answers for, so a delivered one never comes back.
@MainActor
final class HeldSessionSendsTests: XCTestCase {
    final class Reader: HeldSendStatusReading {
        var answers: [String: Result<HeldSendStatus, Error>] = [:]
        /// The transcript's user rows: (message id it names or nil, words). Nil: the read fails.
        var rows: [(String?, String)]? = []
        /// The Mac's own page (`pageable`); false: a companion fallback that may lack rows.
        var pageable = true
        private(set) var asked: [String] = []
        func sessionMessageStatus(sessionId: String, messageId: String) async throws -> HeldSendStatus {
            asked.append(messageId)
            guard let answer = answers[messageId] else { throw APIError.network(underlying: URLError(.timedOut)) }
            return try answer.get()
        }
        func sessionTranscriptPage(id: String, before: String?, since: String?, visible: Int) async throws -> SessionTranscript {
            guard let rows else { throw APIError.network(underlying: URLError(.timedOut)) }
            let messages = rows.map { id, text in
                var m = SessionTranscript.Message(role: "user", text: text, timestamp: since ?? "2026-11-25T00:00:00Z", kind: nil)
                m.walnutMessageId = id
                return m
            }
            var page = SessionTranscript(sessionId: id, exportedAt: since ?? "", truncated: false, messages: messages)
            page.pageable = pageable ? true : nil
            return page
        }
    }

    private let expired = HeldSendStatus(state: "not_sent", code: "send_expired", message: "Not sent: it waited more than a day for clouddev.")
    private let notHere = APIError.server(status: 404, code: "not_found", message: "This server holds no messages", serverHash: nil, serverContent: nil)
    private let forgotten = HeldSendStatus(state: "unknown", message: "Walnut has no record of this message any more.")
    private var outboxKey = ""
    private var dayAndMore: Date { Date().addingTimeInterval(-HeldSessionSends.undeliveredAfter - 60) }

    override func setUp() async throws {
        HeldSessionSends.eraseAll()
        outboxKey = "talk-outbox-test-" + UUID().uuidString
    }

    override func tearDown() async throws {
        HeldSessionSends.eraseAll()
        DurableStore.remove(key: outboxKey)
    }

    private func held(_ id: String, session: String = "s-held", text: String = "note for the CEO", at: Date = Date(), origin: HeldSessionSends.Origin? = nil) {
        if let origin { HeldSessionSends.expect(messageId: id, origin: origin) }
        HeldSessionSends.note(sessionId: session, messageId: id, text: text, pictures: false, at: at)
    }

    private func follow(_ reader: Reader, outbox: TalkOutbox? = nil) async {
        await HeldSessionSends.follow(reader: reader, talkOutbox: outbox ?? TalkOutbox(key: outboxKey), force: true)
    }

    func testOnlyAHeldReceiptIsNotedUnderTheBoxNamedBeforeTheSend() {
        _ = WalnutAPI().sessionSendReceipt(session: "s1", text: "taken", pictures: false, messageId: "qm-mobile-taken00001", queued: nil)
        XCTAssertTrue(HeldSessionSends.all().isEmpty, "a send the server took at once is not followed")
        HeldSessionSends.expect(messageId: "qm-mobile-held000001", origin: .talk)
        let receipt = WalnutAPI().sessionSendReceipt(session: "s1", text: "held", pictures: false, messageId: "qm-mobile-held000001", queued: true)
        XCTAssertTrue(receipt.queued)
        XCTAssertEqual(HeldSessionSends.all().map(\.messageId), ["qm-mobile-held000001"])
        XCTAssertEqual(HeldSessionSends.all().first?.origin, .talk, "named before the send: an app ended right after still knows")
    }

    func testDeliveredIsLetGoAndStillHeldStays() async {
        held("qm-mobile-went0000001")
        held("qm-mobile-wait0000001")
        let reader = Reader()
        reader.answers = ["qm-mobile-went0000001": .success(HeldSendStatus(state: "delivered")),
                          "qm-mobile-wait0000001": .success(HeldSendStatus(state: "held"))]
        await follow(reader)
        XCTAssertEqual(HeldSessionSends.all().map(\.messageId), ["qm-mobile-wait0000001"])
    }

    /// Review round 2, finding 1: delivered while the phone talked to the Mac, then asked of a
    /// companion that forgot it a day later. The conversation has its row: let go, never back.
    func testOneTheCompanionForgotIsLetGoWhenTheConversationHasIt() async {
        held("qm-mobile-forgot00001", at: dayAndMore, origin: .talk)
        let reader = Reader()
        reader.answers = ["qm-mobile-forgot00001": .success(forgotten)]
        reader.rows = [("qm-mobile-forgot00001", "note for the CEO")]
        let outbox = TalkOutbox(key: outboxKey)
        await follow(reader, outbox: outbox)
        XCTAssertTrue(HeldSessionSends.all().isEmpty)
        XCTAssertTrue(outbox.entries.isEmpty, "a delivered note never comes back as not sent")
    }

    /// Finding 2: the phone only reaches the Mac (404). A day past, the conversation has no row:
    /// back for the person, never dropped.
    func testOneOnlyTheMacAnswersForComesBackOnceItsDayIsPastAndTheConversationLacksIt() async throws {
        let session = "held-mac-" + UUID().uuidString.lowercased()
        held("qm-mobile-macyoung001", session: session)
        held("qm-mobile-macold00001", session: session, text: "the lint step failed", at: dayAndMore)
        let reader = Reader()
        reader.answers = ["qm-mobile-macyoung001": .failure(notHere), "qm-mobile-macold00001": .failure(notHere)]
        reader.rows = [("qm-mobile-other000001", "something else")]
        await follow(reader)
        XCTAssertEqual(HeldSessionSends.all().map(\.messageId), ["qm-mobile-macyoung001"], "within the day it may still go")
        let kept = try XCTUnwrap(PendingFileSends.entries(session: session).first)
        XCTAssertEqual(kept.text, "the lint step failed")
        XCTAssertTrue(kept.failed)
        XCTAssertEqual(kept.note, HeldSessionSends.undeliveredSentence)
    }

    /// The companion let it go: back on its session page, not sent, saying why, sent only by the person.
    func testOneTheServerLetGoComesBackNotSentOnItsSessionPageSayingWhy() async throws {
        let session = "held-back-" + UUID().uuidString.lowercased()
        held("qm-mobile-gone0000001", session: session, text: "the lint step failed")
        let reader = Reader()
        reader.answers = ["qm-mobile-gone0000001": .success(expired)]
        await follow(reader)
        XCTAssertTrue(HeldSessionSends.all().isEmpty)
        let kept = try XCTUnwrap(PendingFileSends.entries(session: session).first)
        XCTAssertNotEqual(kept.messageID, "qm-mobile-gone0000001", "the server answers the old id not sent for good")

        let transport = MockSessionSendTransport()
        let page = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: FakeUploadHost())
        await page.open()
        let back = try XCTUnwrap(page.messages.first { $0.text == "the lint step failed" })
        XCTAssertEqual(back.failed, true)
        XCTAssertEqual(page.errorMessage, expired.message, "the page says why it is back")
        XCTAssertTrue(transport.sendCalls.isEmpty)
        await page.retry(back)
        XCTAssertEqual(transport.sendCalls.map(\.messageId), [kept.messageID])
        page.close()
    }

    func testOneFromTheActionButtonComesBackInItsList() async throws {
        held("qm-mobile-talk0000001", text: "remind me about the fern", origin: .talk)
        let outbox = TalkOutbox(key: outboxKey)
        let reader = Reader()
        reader.answers = ["qm-mobile-talk0000001": .success(expired)]
        let backToTalk = await HeldSessionSends.follow(reader: reader, talkOutbox: outbox, force: true)
        XCTAssertTrue(backToTalk, "the list is offered at once")
        let entry = try XCTUnwrap(outbox.unsent.first)
        XCTAssertEqual(entry.text, "remind me about the fern")
        XCTAssertEqual(entry.reason, expired.message)
        XCTAssertNotEqual(entry.messageId, "qm-mobile-talk0000001")
        XCTAssertFalse(TalkSession.waits(entry), "the person's to send again: a day-old note never goes by itself")
        XCTAssertTrue(PendingFileSends.entries(session: "s-held").isEmpty, "one place only")
    }

    /// Finding 4: a thread's Follow up comes back in that thread's box, after what is being written.
    func testAThreadFollowUpComesBackInItsThreadBox() async {
        let key = OrgThreadFollowUpDraft.key(nodeId: "node-1", threadId: "th-" + UUID().uuidString)
        let drafts = ComposerDrafts.shared
        drafts.setDraft("half a thought", key: key)
        defer { drafts.setDraft("", key: key) }
        held("qm-mobile-thread00001", text: "go with the second option", origin: .thread(draftKey: key))
        let reader = Reader()
        reader.answers = ["qm-mobile-thread00001": .success(expired)]
        await HeldSessionSends.follow(reader: reader, talkOutbox: TalkOutbox(key: outboxKey), drafts: drafts, force: true)
        XCTAssertEqual(drafts.draft(key), "half a thought\n\ngo with the second option")
        XCTAssertEqual(drafts.returnNote(key), expired.message, "the box says why the words are back")
        XCTAssertTrue(PendingFileSends.entries(session: "s-held").isEmpty)
        drafts.clear(key)
        XCTAssertNil(drafts.returnNote(key), "gone with the words")
    }

    /// Review round 3: a companion fallback page (its bridge tail, its synced copy) can lack a row
    /// without saying so. It finds a delivered row, but its "not there" proves nothing.
    func testOnlyTheMacsOwnPageProvesARowIsMissing() async {
        held("qm-mobile-tail0000001", at: dayAndMore, origin: .talk)
        held("qm-mobile-tailseen001", text: "seen on the tail", at: dayAndMore)
        let reader = Reader()
        reader.answers = ["qm-mobile-tail0000001": .success(forgotten), "qm-mobile-tailseen001": .success(forgotten)]
        reader.rows = [("qm-mobile-tailseen001", "seen on the tail")]
        reader.pageable = false
        let outbox = TalkOutbox(key: outboxKey)
        await follow(reader, outbox: outbox)
        XCTAssertEqual(HeldSessionSends.all().map(\.messageId), ["qm-mobile-tail0000001"], "kept, never put back on a partial page")
        XCTAssertTrue(outbox.entries.isEmpty)
    }

    /// Finding 3: "unknown" is never taken for "not sent" while it may still arrive, and a
    /// conversation that cannot be read settles nothing until days have passed.
    func testUnknownWaitsForTheConversationAndNothingIsSettledOnAGuess() async {
        held("qm-mobile-unknown0001")
        held("qm-mobile-unread00001", at: dayAndMore)
        held("qm-mobile-unreadold01", at: Date().addingTimeInterval(-HeldSessionSends.givenBackAfter - 60), origin: .talk)
        let reader = Reader()
        reader.answers = ["qm-mobile-unknown0001": .success(forgotten)]
        reader.rows = nil
        let outbox = TalkOutbox(key: outboxKey)
        await follow(reader, outbox: outbox)
        XCTAssertEqual(Set(HeldSessionSends.all().map(\.messageId)), ["qm-mobile-unknown0001", "qm-mobile-unread00001"])
        XCTAssertEqual(outbox.unsent.first?.reason, HeldSessionSends.unsettledSentence, "after days, back for the person to check first")
    }

    func testAFollowUpRightAfterAnotherAsksNothing() async {
        held("qm-mobile-wait0000002")
        let reader = Reader()
        reader.answers = ["qm-mobile-wait0000002": .success(HeldSendStatus(state: "held"))]
        let now = Date()
        await HeldSessionSends.follow(reader: reader, talkOutbox: TalkOutbox(key: outboxKey), now: now, force: true)
        await HeldSessionSends.follow(reader: reader, talkOutbox: TalkOutbox(key: outboxKey), now: now.addingTimeInterval(5))
        XCTAssertEqual(reader.asked.count, 1)
        await HeldSessionSends.follow(reader: reader, talkOutbox: TalkOutbox(key: outboxKey), now: now.addingTimeInterval(HeldSessionSends.followGap + 1))
        XCTAssertEqual(reader.asked.count, 2)
    }
}
