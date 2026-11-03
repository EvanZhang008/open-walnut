import XCTest
@testable import Walnut

/// Talk to CEO and New task on an email: the content the phone hands over (the web's
/// `itemContent`), the draft it never overwrites, and the cross-tab requests.
@MainActor
final class ContentActionLinkTests: XCTestCase {
    private func item(_ json: String = InboxItemContractTests.itemJSON) throws -> InboxEmailItem {
        try JSONDecoder().decode(InboxEmailItem.self, from: Data(json.utf8))
    }

    func testEmailBecomesTheWebsContentItem() throws {
        let content = try XCTUnwrap(try item().contentItem)
        XCTAssertEqual(content, ContentItem(
            source: "Mail", title: "Weekly update", summary: "Review the update",
            from: "Sender One <sender@example.test>", at: "2026-10-20T10:00:00Z",
            whereText: "Personal", open: "/mail?account=account-one&message=message-one"
        ))
        let wire = try XCTUnwrap(String(data: JSONEncoder().encode(content), encoding: .utf8))
        XCTAssertTrue(wire.contains(#""where":"Personal""#))
        XCTAssertFalse(wire.contains("whereText"))
        // A field the item lacks is left out, never sent as null.
        XCTAssertFalse(wire.contains("null"))
    }

    func testOpenLinkEscapesWhatAQueryWouldMisread() throws {
        let json = InboxItemContractTests.itemJSON.replacingOccurrences(of: #""message":"message-one""#, with: #""message":"<a+b&c@x>""#)
        let content = try XCTUnwrap(try item(json).contentItem)
        XCTAssertEqual(content.open, "/mail?account=account-one&message=%3Ca%2Bb%26c%40x%3E")
    }

    func testPlaceholderSummaryAndMissingFieldsAreLeftOut() throws {
        let json = """
        {"id":"mail-two","subject":"","summary":"Email summary unavailable","source":{"kind":"mail","account":"a","message":"m"},
        "display":{"sender":{"address":"only@example.test"},"accountHint":"hint@example.test"},
        "actions":[{"id":"read-two","kind":"op","intent":"mark_read"}]}
        """
        let content = try XCTUnwrap(try item(json).contentItem)
        XCTAssertNil(content.summary)
        XCTAssertNil(content.at)
        XCTAssertEqual(content.from, "only@example.test")
        XCTAssertEqual(content.whereText, "hint@example.test")
        XCTAssertFalse(content.title.isEmpty)
    }

    func testAnUnavailableEmailOffersNoContentActions() throws {
        let json = InboxItemContractTests.itemJSON.replacingOccurrences(of: #""intent":"mark_read""#, with: #""intent":"delete_mail""#)
        XCTAssertNil(try item(json).contentItem)
    }

    func testDraftKeepsWhatThePersonTyped() {
        let added = "Weekly update\n\nFrom: Sender One\n\n"
        XCTAssertEqual(ContentActionLink.merged(existing: "", adding: added), added)
        XCTAssertEqual(ContentActionLink.merged(existing: "  \n", adding: added), added)
        XCTAssertEqual(ContentActionLink.merged(existing: "Look into this", adding: added), "Look into this\n\n" + added)
        // The same email twice is not pasted twice.
        let once = ContentActionLink.merged(existing: "Look into this", adding: added)
        XCTAssertEqual(ContentActionLink.merged(existing: once, adding: added), once)
        XCTAssertEqual(ContentActionLink.merged(existing: "Mine", adding: "  "), "Mine")
    }

    func testRequestsAreTakenOnceAndExpire() {
        let link = ContentActionLink.shared
        let now = Date()
        link.openDraft(text: "words", now: now)
        XCTAssertEqual(link.consumeDraft(now: now)?.text, "words")
        XCTAssertNil(link.consumeDraft(now: now))
        link.openChat(taskId: "main-task", sessionId: "s-1", now: now)
        XCTAssertNil(link.consumeChat(now: now.addingTimeInterval(ContentActionLink.requestTTL + 1)))
        XCTAssertNil(link.chat)
    }

    func testRefusalsSayWhatToDo() {
        let offline = APIError.server(status: 501, code: "not_supported_cloud", message: "", serverHash: nil, serverContent: nil)
        XCTAssertEqual(ContentActionButtons.failureWords("Talk to CEO", offline), "Talk to CEO works only while your Mac is online.")
        let old = APIError.server(status: 404, code: "not_found", message: "", serverHash: nil, serverContent: nil)
        XCTAssertEqual(ContentActionButtons.failureWords("New task", old), "New task needs a newer Walnut on your Mac.")
        // A lost answer may still have reached the CEO: never invite a blind second send.
        let late = APIError.network(underlying: URLError(.timedOut))
        XCTAssertTrue(ContentActionButtons.failureWords("Talk to CEO", late).contains("may have been sent"))
        XCTAssertTrue(ContentActionButtons.failureWords("Talk to CEO", URLError(.timedOut)).contains("may have been sent"))
        let held = ContentCeoReply(taskId: "t", sessionId: "s", started: false, held: true, testRun: nil)
        XCTAssertEqual(ContentActionButtons.chatReply(.held(held)), held)
        XCTAssertNil(ContentActionButtons.chatReply(.failed("x")))
        // A send that may have gone through still offers the chat to check; one in flight does not.
        XCTAssertTrue(ContentActionButtons.offersChat(.timedOut))
        XCTAssertTrue(ContentActionButtons.offersChat(.held(held)))
        XCTAssertFalse(ContentActionButtons.offersChat(.sending))
        XCTAssertFalse(ContentActionButtons.offersChat(.failed("x")))
        XCTAssertTrue(ContentActionButtons.isWarning(.timedOut))
    }

    func testTheNoteNeedsWordsThatFit() {
        XCTAssertFalse(CeoNoteSheet.canSend(""))
        XCTAssertFalse(CeoNoteSheet.canSend("  \n\t "))
        XCTAssertTrue(CeoNoteSheet.canSend("Please handle this"))
        XCTAssertTrue(CeoNoteSheet.canSend(String(repeating: "a", count: CeoNoteSheet.noteLimit)))
        XCTAssertFalse(CeoNoteSheet.canSend(String(repeating: "a", count: CeoNoteSheet.noteLimit + 1)))
        // CJK test data (\u4F60\u597D): counted as characters, not bytes.
        XCTAssertTrue(CeoNoteSheet.canSend(String(repeating: "\u{4F60}\u{597D}", count: CeoNoteSheet.noteLimit / 2)))
    }

    func testEachEmailKeepsItsOwnNote() throws {
        let one = try XCTUnwrap(try item().contentItem)
        let json = InboxItemContractTests.itemJSON.replacingOccurrences(of: #""message":"message-one""#, with: #""message":"message-two""#)
        let two = try XCTUnwrap(try item(json).contentItem)
        XCTAssertNotEqual(CeoNoteSheet.draftKey(one), CeoNoteSheet.draftKey(two))
        XCTAssertEqual(CeoNoteSheet.draftKey(one), CeoNoteSheet.draftKey(one))
    }

    func testAReplyWithoutNotedSaysTheWordsWereLeftOut() {
        let noted = ContentCeoReply(taskId: "t", sessionId: "s", started: true, held: nil, testRun: nil, noted: true)
        XCTAssertEqual(ContentActionButtons.outcome(of: noted), .sent(noted))
        // An older server ignores `note` and answers as before.
        let old = ContentCeoReply(taskId: "t", sessionId: "s", started: true, held: nil, testRun: nil)
        XCTAssertEqual(ContentActionButtons.outcome(of: old), .sentWithoutNote(old))
        XCTAssertTrue(ContentActionButtons.isWarning(.sentWithoutNote(old)))
        XCTAssertTrue(ContentActionButtons.offersChat(.sentWithoutNote(old)))
        XCTAssertEqual(ContentActionButtons.statusText(.sentWithoutNote(old)), ContentActionButtons.sentWithoutNoteWords)
        let held = ContentCeoReply(taskId: "t", sessionId: "s", started: false, held: true, testRun: nil, noted: true)
        XCTAssertEqual(ContentActionButtons.outcome(of: held), .held(held))
    }

    func testNotedDecodesAndIsOptional() throws {
        let with = try JSONDecoder().decode(ContentCeoReply.self, from: Data(#"{"taskId":"t","sessionId":"s","started":true,"noted":true}"#.utf8))
        XCTAssertEqual(with.noted, true)
        let without = try JSONDecoder().decode(ContentCeoReply.self, from: Data(#"{"taskId":"t","started":true}"#.utf8))
        XCTAssertNil(without.noted)
    }

    func testUnsentNotesAreCappedButTheOpenOneStays() {
        let drafts = ComposerDrafts.shared
        let keys = (0..<6).map { "test-trim:\($0)" }
        defer { keys.forEach { drafts.clear($0) } }
        for key in keys { drafts.setDraft("words", key: key) }
        drafts.trimDrafts(prefix: "test-trim:", keeping: "test-trim:0", max: 2)
        XCTAssertEqual(drafts.draft("test-trim:0"), "words")
        XCTAssertEqual(keys.dropFirst().filter { !drafts.draft($0).isEmpty }.count, 2)
        // Under the cap nothing goes.
        drafts.trimDrafts(prefix: "test-trim:", keeping: "test-trim:0", max: 2)
        XCTAssertEqual(keys.filter { !drafts.draft($0).isEmpty }.count, 3)
    }

    func testDraftFocusIsTakenOnce() {
        let link = ContentActionLink.shared
        XCTAssertFalse(link.takeDraftFocus())
        link.requestDraftFocus()
        XCTAssertTrue(link.takeDraftFocus())
        XCTAssertFalse(link.takeDraftFocus())
    }
}
