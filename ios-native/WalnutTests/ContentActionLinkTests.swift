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
}
