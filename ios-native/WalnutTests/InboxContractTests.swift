import WebKit
import XCTest
@testable import Walnut

/// Human Inbox decode contract + the pure helpers around it.
///
/// What is worth pinning here, and why:
///  - **Lenient decode.** The phone must keep rendering an inbox when a newer
///    server adds fields, and one odd record must never empty the list. So the
///    minimal-record cases matter as much as the full ones.
///  - **Envelope formatting.** The row is the only thing most letters ever show,
///    and a markdown-derived preview arrives with newlines and runs of spaces.
///  - **Push routing.** A push payload is untrusted input that becomes a URL
///    path, and the same logical `data` object reaches iOS in three different
///    shapes depending on the sender.
///  - **The WKWebView security floor.** JavaScript-off is the whole reason a
///    letter body is safe to open blind on a phone; a future edit must trip a
///    test, not ship.
///
/// The reader/list views themselves are covered by the simulator pass, not here.
@MainActor
final class InboxContractTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    /// A full letter as the store writes it (epoch-ms stamps, camelCase keys).
    private let fullLetterJSON = """
    { "letter": {
        "id": "lt-mabcdef-9x7q",
        "subject": "Root cause of the sync freeze",
        "type": "action_required",
        "bodyFormat": "markdown",
        "textPreview": "The freeze is a lock held across a fetch. Two ways out.",
        "sender": { "sessionId": "abc123def456", "sessionTitle": "Investigate sync freeze",
                    "taskId": "task-77", "taskTitle": "Sync freezes after compaction",
                    "project": "walnut", "host": "devbox" },
        "createdAt": 1755900000000,
        "read": false, "pinned": false, "archived": false,
        "actions": [ { "id": "a", "label": "Fix it now", "description": "Ship the small patch" },
                     { "id": "b", "label": "Wait for the rewrite" } ],
        "thread": [ { "from": "human", "text": "does this explain Tuesday too?", "at": 1755900500000 },
                    { "from": "agent", "text": "yes", "bodyFormat": "markdown",
                      "bodyFile": "lt-mabcdef-9x7q.r1.md", "body": "## Yes\\nSame lock.",
                      "at": 1755901000000 } ],
        "taskRefs": ["task-77"],
        "body": "# Root cause\\nA lock is held across the fetch."
    } }
    """

    // MARK: - Decode

    func testFullLetterDecodes() throws {
        let letter = try decode(LetterResponse.self, fullLetterJSON).letter
        XCTAssertEqual(letter.id, "lt-mabcdef-9x7q")
        XCTAssertEqual(letter.kind, .actionRequired)
        XCTAssertEqual(letter.kind.label, "Action needed")
        XCTAssertFalse(letter.isRead)
        XCTAssertFalse(letter.isHTMLBody)
        XCTAssertEqual(letter.sender?.taskTitle, "Sync freezes after compaction")
        XCTAssertEqual(letter.taskTitle, "Sync freezes after compaction")
        XCTAssertEqual(letter.hostLabel, "devbox")
        XCTAssertEqual(letter.actions?.count, 2)
        XCTAssertEqual(letter.openActions.map(\.id), ["a", "b"])
        XCTAssertTrue(letter.isAwaitingDecision)
        XCTAssertEqual(letter.threadEntries.count, 2)
        XCTAssertEqual(letter.taskRefs, ["task-77"])
        XCTAssertEqual(letter.body, "# Root cause\nA lock is held across the fetch.")
        XCTAssertNotNil(letter.createdDate)
    }

    /// Everything past id/subject/type is optional: a newer server that drops or
    /// renames a field must degrade to a renderable row, not a decode failure.
    func testMinimalLetterDecodes() throws {
        let letter = try decode(Letter.self, #"{ "id": "lt-x-abcd", "subject": "Hi", "type": "info" }"#)
        XCTAssertEqual(letter.kind, .info)
        XCTAssertFalse(letter.isRead)
        XCTAssertFalse(letter.isPinned)
        XCTAssertFalse(letter.isArchived)
        XCTAssertEqual(letter.previewLine, "")
        XCTAssertEqual(letter.senderName, "External agent")
        XCTAssertEqual(letter.hostLabel, "Mac")
        XCTAssertTrue(letter.threadEntries.isEmpty)
        XCTAssertTrue(letter.openActions.isEmpty)
        XCTAssertNil(letter.createdDate)
    }

    func testUnknownLetterTypeStaysRenderable() throws {
        let letter = try decode(Letter.self, #"{ "id": "lt-x-abcd", "subject": "S", "type": "digest" }"#)
        XCTAssertEqual(letter.kind, .unknown)
        XCTAssertEqual(letter.kind.label, "Letter")
        XCTAssertFalse(letter.kind.symbol.isEmpty)
        XCTAssertFalse(letter.isAwaitingDecision, "only action_required blocks the human")
    }

    func testAnsweredLetterStopsAskingForADecision() throws {
        let letter = try decode(Letter.self, """
        { "id": "lt-x-abcd", "subject": "Fork", "type": "action_required",
          "actions": [ { "id": "a", "label": "A" } ],
          "answered": { "actionId": "a", "label": "A", "freeText": "after tests",
                        "at": 1755902000000 } }
        """)
        XCTAssertFalse(letter.isAwaitingDecision)
        XCTAssertTrue(letter.openActions.isEmpty, "answered letters render the record, not buttons")
        XCTAssertEqual(letter.answered?.freeText, "after tests")
        XCTAssertNotNil(letter.answered?.date)
    }

    /// An archived action_required letter is filed, not pending — it must not
    /// keep showing up as something the human owes an answer to.
    func testArchivedActionRequiredIsNotPending() throws {
        let letter = try decode(Letter.self, """
        { "id": "lt-x-abcd", "subject": "Old fork", "type": "action_required",
          "archived": true, "actions": [ { "id": "a", "label": "A" } ] }
        """)
        XCTAssertFalse(letter.isAwaitingDecision)
    }

    func testListResponseDecodes() throws {
        let response = try decode(LetterListResponse.self, """
        { "letters": [ { "id": "lt-a-abcd", "subject": "One", "type": "info" },
                       { "id": "lt-b-abcd", "subject": "Two", "type": "review", "read": true } ],
          "unreadCount": 1 }
        """)
        XCTAssertEqual(response.letters.count, 2)
        XCTAssertEqual(response.unreadCount, 1)
    }

    func testThreadEntryRolesAndRichBodies() throws {
        let letter = try decode(LetterResponse.self, fullLetterJSON).letter
        let human = letter.threadEntries[0]
        let agent = letter.threadEntries[1]
        XCTAssertTrue(human.isHuman)
        XCTAssertFalse(agent.isHuman)
        XCTAssertFalse(agent.isHTMLBody)
        XCTAssertEqual(agent.body, "## Yes\nSame lock.")
        XCTAssertNotNil(agent.date)
        XCTAssertNotEqual(human.id, agent.id, "thread ids must distinguish turns")
    }

    // MARK: - Envelope formatting

    func testPreviewCollapsesWhitespaceToOneLine() throws {
        let letter = try decode(Letter.self, """
        { "id": "lt-x-abcd", "subject": "S", "type": "info",
          "textPreview": "  first line\\n\\nsecond   line\\ttabbed  " }
        """)
        XCTAssertEqual(letter.previewLine, "first line second line tabbed")
    }

    func testPreviewIsBoundedWithAnEllipsis() {
        let long = String(repeating: "x", count: Letter.previewCap + 50)
        let clipped = Letter.oneLine(long)
        XCTAssertEqual(clipped.count, Letter.previewCap + 1, "cap plus the ellipsis")
        XCTAssertTrue(clipped.hasSuffix("…"))
    }

    func testPreviewShorterThanTheCapIsUntouched() {
        XCTAssertEqual(Letter.oneLine("short and sweet"), "short and sweet")
        XCTAssertEqual(Letter.oneLine("   "), "")
    }

    func testSenderNameFallsBackHonestly() throws {
        let titled = try decode(Letter.self, """
        { "id": "lt-x-abcd", "subject": "S", "type": "info",
          "sender": { "sessionId": "sid", "sessionTitle": "Nightly investigation", "host": "local" } }
        """)
        XCTAssertEqual(titled.senderName, "Nightly investigation")
        XCTAssertEqual(titled.hostLabel, "Mac", "'local' is the internal alias for the primary box")

        let untitled = try decode(Letter.self, """
        { "id": "lt-x-abcd", "subject": "S", "type": "info",
          "sender": { "sessionId": "abcdef1234567890", "host": "__local__" } }
        """)
        XCTAssertEqual(untitled.senderName, "Session abcdef12")
        XCTAssertEqual(untitled.hostLabel, "Mac")

        let external = try decode(Letter.self, """
        { "id": "lt-x-abcd", "subject": "S", "type": "info",
          "sender": { "sessionId": "external", "host": "local" } }
        """)
        XCTAssertEqual(external.senderName, "External agent",
                       "a hand-started agent has no tracked session — say so plainly")
    }

    func testBlankSessionTitleDoesNotProduceABlankRow() throws {
        let letter = try decode(Letter.self, """
        { "id": "lt-x-abcd", "subject": "S", "type": "info",
          "sender": { "sessionId": "abcdef1234", "sessionTitle": "   ", "host": "" } }
        """)
        XCTAssertEqual(letter.senderName, "Session abcdef12")
        XCTAssertNil(letter.taskTitle)
    }

    // MARK: - Ordering

    func testPinnedSortFirstThenNewest() throws {
        func letter(_ id: String, pinned: Bool, at: Double) throws -> Letter {
            try decode(Letter.self, """
            { "id": "\(id)", "subject": "S", "type": "info",
              "pinned": \(pinned), "createdAt": \(at) }
            """)
        }
        let rows = [
            try letter("lt-a-abcd", pinned: false, at: 3),
            try letter("lt-b-abcd", pinned: true, at: 1),
            try letter("lt-c-abcd", pinned: false, at: 5),
            try letter("lt-d-abcd", pinned: true, at: 2),
        ].sorted(by: Letter.isOrderedBefore)
        XCTAssertEqual(rows.map(\.id), ["lt-d-abcd", "lt-b-abcd", "lt-c-abcd", "lt-a-abcd"])
    }

    // MARK: - Body clipping

    func testOversizeBodyIsClippedAndSaysSo() throws {
        let body = String(repeating: "y", count: Letter.phoneBodyCap + 10)
        let letter = try decode(Letter.self, """
        { "id": "lt-x-abcd", "subject": "S", "type": "review", "body": "\(body)" }
        """)
        XCTAssertTrue(letter.bodyWasClipped)
        XCTAssertEqual(letter.displayBody.count, Letter.phoneBodyCap)
    }

    func testOrdinaryBodyIsNotClipped() throws {
        let letter = try decode(Letter.self, """
        { "id": "lt-x-abcd", "subject": "S", "type": "review", "body": "# Short\\nfine" }
        """)
        XCTAssertFalse(letter.bodyWasClipped)
        XCTAssertEqual(letter.displayBody, "# Short\nfine")
    }

    // MARK: - Delivery vocabulary

    func testDeliveryTextCoversEveryStatus() throws {
        func delivery(_ json: String) throws -> LetterDelivery { try decode(LetterDelivery.self, json) }

        XCTAssertEqual(try delivery(#"{ "status": "queued", "messageId": "qm-1" }"#).humanText,
                       "Sent to the agent")
        XCTAssertTrue(try delivery(#"{ "status": "deferred", "reason": "origin_awaiting_permission" }"#)
            .humanText.contains("permission prompt"))
        XCTAssertTrue(try delivery(#"{ "status": "skipped", "reason": "no_origin_session" }"#)
            .humanText.contains("no origin session"))
        XCTAssertTrue(try delivery(#"{ "status": "skipped", "reason": "origin_session_gone" }"#)
            .humanText.contains("sending session is gone"))
        XCTAssertTrue(try delivery(#"{ "status": "failed", "reason": "timeout" }"#)
            .humanText.contains("failed"))
        // An unknown/absent status must still read as "your answer is on record",
        // because the route wrote the thread entry before it tried to deliver.
        XCTAssertEqual(try delivery(#"{ "status": "invented_later" }"#).humanText, "Saved")
        XCTAssertEqual(try delivery("{}").humanText, "Saved")
    }

    func testOnlyFailedCountsAsAProblem() throws {
        XCTAssertTrue(try decode(LetterDelivery.self, #"{ "status": "failed" }"#).isProblem)
        XCTAssertFalse(try decode(LetterDelivery.self, #"{ "status": "deferred" }"#).isProblem,
                       "deferred means parked in the session queue, not lost")
        XCTAssertFalse(try decode(LetterDelivery.self, #"{ "status": "skipped" }"#).isProblem)
    }

    func testActionResultCarriesLetterAndDelivery() throws {
        let result = try decode(LetterActionResult.self, """
        { "letter": { "id": "lt-x-abcd", "subject": "S", "type": "action_required",
                      "read": true, "body": "done",
                      "answered": { "actionId": "a", "label": "A", "at": 1 } },
          "delivery": { "status": "queued", "sessionId": "sid", "messageId": "qm-9" } }
        """)
        XCTAssertEqual(result.letter?.answered?.actionId, "a")
        XCTAssertEqual(result.letter?.body, "done")
        XCTAssertEqual(result.delivery?.status, "queued")
        XCTAssertEqual(result.delivery?.humanText, "Sent to the agent")
    }

    // MARK: - Push deep link

    func testLetterIdValidationMatchesTheServerShape() {
        XCTAssertTrue(LetterDeepLink.isValidLetterId("lt-mabcdef-9x7q"))
        XCTAssertTrue(LetterDeepLink.isValidLetterId("lt-a-abcd"))
        // Anything that isn't a letter id must never reach the server as a path.
        XCTAssertFalse(LetterDeepLink.isValidLetterId("lt-a-abc"), "rand section is 4-12 chars")
        XCTAssertFalse(LetterDeepLink.isValidLetterId("lt--abcd"))
        XCTAssertFalse(LetterDeepLink.isValidLetterId("lt-a-abcd/../secrets"))
        XCTAssertFalse(LetterDeepLink.isValidLetterId("lt-A-ABCD"), "lowercase base36 only")
        XCTAssertFalse(LetterDeepLink.isValidLetterId("task-77"))
        XCTAssertFalse(LetterDeepLink.isValidLetterId(""))
    }

    func testPushRoutingAcceptsAllThreeEnvelopeShapes() {
        let id = "lt-mabcdef-9x7q"
        // Flat (what a plain APNs sender produces).
        XCTAssertEqual(
            LetterDeepLink.letterId(fromPush: ["type": LetterDeepLink.payloadType, "letterId": id]),
            id
        )
        // Nested under `data`.
        XCTAssertEqual(
            LetterDeepLink.letterId(fromPush: ["data": ["type": LetterDeepLink.payloadType, "letterId": id]]),
            id
        )
        // Expo's iOS shape: the data object lands under `body`, sometimes as a
        // JSON STRING. Reading only one shape is how a deep link silently dies.
        XCTAssertEqual(
            LetterDeepLink.letterId(fromPush: ["body": #"{"type":"human_inbox_letter","letterId":"\#(id)"}"#]),
            id
        )
    }

    func testPushRoutingIgnoresEveryOtherNotification() {
        XCTAssertNil(LetterDeepLink.letterId(fromPush: [:]))
        XCTAssertNil(LetterDeepLink.letterId(fromPush: ["type": "session_result", "sessionId": "s"]))
        XCTAssertNil(LetterDeepLink.letterId(fromPush: ["type": "cron"]))
        // Right type, unusable id → refuse rather than send junk to the server.
        XCTAssertNil(LetterDeepLink.letterId(
            fromPush: ["type": LetterDeepLink.payloadType, "letterId": "../../etc/passwd"]
        ))
        XCTAssertNil(LetterDeepLink.letterId(fromPush: ["type": LetterDeepLink.payloadType]))
        // A letterId with no type is not a letter push (could be any payload).
        XCTAssertNil(LetterDeepLink.letterId(fromPush: ["letterId": "lt-a-abcd"]))
    }

    /// A TAP is a user instruction and opens the reader. A silent/background
    /// delivery is not: it only bumps the arrival counter so the badge refreshes,
    /// because opening the app minutes later must not yank the user into a letter.
    func testOnlyATapArmsTheReader() {
        let link = LetterDeepLink.shared
        link.clear()
        let payload: [AnyHashable: Any] = [
            "type": LetterDeepLink.payloadType, "letterId": "lt-mabcdef-9x7q",
        ]
        let before = link.arrivals

        XCTAssertTrue(link.handle(push: payload, source: "background"))
        XCTAssertNil(link.pending, "a background push must not navigate")
        XCTAssertEqual(link.arrivals, before + 1, "but it must still refresh the badge")

        XCTAssertTrue(link.handle(push: payload, source: LetterDeepLink.tapSource))
        XCTAssertEqual(link.pending?.letterId, "lt-mabcdef-9x7q")
        XCTAssertEqual(link.arrivals, before + 2)

        // Consuming clears the mailbox: a stale link must not reopen the letter
        // on every appear.
        XCTAssertEqual(link.consume()?.letterId, "lt-mabcdef-9x7q")
        XCTAssertNil(link.pending)
        XCTAssertNil(link.consume())
    }

    func testForeignPushLeavesTheMailboxAlone() {
        let link = LetterDeepLink.shared
        link.clear()
        let before = link.arrivals
        XCTAssertFalse(link.handle(push: ["type": "session_result"], source: LetterDeepLink.tapSource))
        XCTAssertNil(link.pending)
        XCTAssertEqual(link.arrivals, before)
    }

    func testStaleDeepLinkExpires() {
        let request = LetterDeepLink.Request(
            letterId: "lt-a-abcd", requestedAt: Date(timeIntervalSince1970: 1_000), source: "tap"
        )
        let now = Date(timeIntervalSince1970: 1_000 + LetterDeepLink.requestTTL + 1)
        XCTAssertFalse(LetterDeepLink.isFresh(request, now: now))
        XCTAssertTrue(LetterDeepLink.isFresh(request, now: Date(timeIntervalSince1970: 1_010)))
        // A clock corrected backwards is tolerated to the same window, then
        // refused — an untrustworthy timestamp shouldn't drive navigation.
        XCTAssertTrue(LetterDeepLink.isFresh(request, now: Date(timeIntervalSince1970: 990)))
        XCTAssertFalse(LetterDeepLink.isFresh(
            request, now: Date(timeIntervalSince1970: 1_000 - LetterDeepLink.requestTTL - 1)
        ))
    }

    // MARK: - HTML body posture

    /// The security floor. A letter body is arbitrary agent-authored markup read
    /// blind on a phone; JavaScript-off + nothing-persisted is what makes that
    /// safe, so a future edit has to trip this test rather than ship.
    func testLetterBodyWebViewDisablesJavaScript() {
        let config = LetterHTMLBody.webViewConfiguration()
        XCTAssertFalse(config.defaultWebpagePreferences.allowsContentJavaScript,
                       "a letter body must never run scripts")
        XCTAssertFalse(config.websiteDataStore.isPersistent,
                       "no cookie jar or storage shared with the app")
    }

    func testLetterDocumentCarriesTheCSPAndTheBodyVerbatim() {
        let body = "<h1>Hi</h1><p>Read me</p>"
        let document = LetterHTMLBody.document(wrapping: body)
        XCTAssertTrue(document.contains(body), "the agent's markup is never rewritten")
        // default-src 'none' is what stops a tracker pixel from reporting the
        // moment (and IP) the human read the letter.
        XCTAssertTrue(document.contains("Content-Security-Policy"))
        XCTAssertTrue(document.contains("default-src 'none'"))
        XCTAssertTrue(document.contains("img-src data: blob:"))
        XCTAssertTrue(document.contains("width=device-width"))
        // No remote stylesheet/font/script hooks of our own, either.
        XCTAssertFalse(document.contains("http://"))
        XCTAssertFalse(document.contains("https://"))
    }

    // MARK: - Markdown body posture

    /// The markdown body must have the SAME floor as the html one. It renders
    /// through the app's markdown pipeline, whose image blocks fetch any
    /// `http(s)://` reference directly and unauthenticated — so a tracker pixel
    /// written as `![](https://…)` (or as a bare image URL, which the parser
    /// auto-detects) would leak the read time, IP and user agent that the html
    /// path's CSP blocks.
    func testRemoteImageReferencesAreRefusedInALetterBody() {
        for remote in [
            "https://tracker.example/p.png",
            "http://tracker.example/p.png",
            "  HTTPS://Tracker.Example/p.png  ",
            "ftp://example.net/p.png",
            "file:///etc/passwd",
        ] {
            XCTAssertTrue(LetterMarkdownBody.isRemoteReference(remote), "must refuse \(remote)")
        }
        // Everything that stays inside Walnut still renders.
        for local in [
            "/tmp/run/shot.png",
            "shot.png",
            "_attachment/shot.png",
            "data:image/png;base64,AAAA",
            "blob:1234",
        ] {
            XCTAssertFalse(LetterMarkdownBody.isRemoteReference(local), "must still render \(local)")
        }
    }

    func testRemoteImageBlockBecomesANoteAndLocalOnesSurvive() {
        let markdown = """
        Findings below.

        ![chart](https://tracker.example/p.png)

        ![local](/tmp/run/shot.png)
        """
        let blocks = LetterMarkdownBody.blocks(for: markdown)
        let images = blocks.compactMap { block -> String? in
            if case .image(let raw, _) = block.kind { return raw }
            return nil
        }
        XCTAssertEqual(images, ["/tmp/run/shot.png"], "only the host-local image is still fetched")
        let paragraphs = blocks.compactMap { block -> String? in
            if case .paragraph(let text) = block.kind { return String(text.characters) }
            return nil
        }
        // Never silently dropped: the human sees that something was skipped, and
        // the agent's alt text names it.
        XCTAssertTrue(paragraphs.contains { $0.contains("Image not loaded") && $0.contains("chart") },
                      "a blocked image leaves a visible note, got \(paragraphs)")
    }

    func testABareRemoteImageURLIsAlsoRefused() {
        // The parser auto-detects bare image references, so no explicit image
        // syntax is needed to trigger a fetch.
        let blocks = LetterMarkdownBody.blocks(for: "see ![](https://tracker.example/pixel.gif) now")
        for block in blocks {
            if case .image(let raw, _) = block.kind {
                XCTFail("still fetching \(raw)")
            }
        }
    }
}
