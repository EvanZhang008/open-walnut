import XCTest
@testable import Walnut

/// A path in an Org thread card opens on the machine of whoever wrote the words around it (the
/// web's `thread-text-source.ts`): the summary by its recorded writer, an answer by the session it
/// was read from, an opening post by its post. A block with no writer recorded is unknown, so a
/// tap asks which machine instead of guessing one.
final class OrgThreadSourceTests: XCTestCase {
    private func decode(_ json: String) throws -> OrgThread {
        try JSONDecoder().decode(OrgThread.self, from: Data(json.utf8))
    }

    private func thread(_ extra: String = "", messages: String = "[]") throws -> OrgThread {
        try decode(#"""
        {"id":"th-1","title":"T","state":"answered","messages":\#(messages),
         "createdAt":"2026-11-08T10:00:00Z","updatedAt":"2026-11-08T10:00:00Z"\#(extra)}
        """#)
    }

    func testTheSummaryWriterTheServerRecordedIsDecodedAndOpensOnThatSession() throws {
        let t = try thread(#","reply":"see /p/a.ts","reply_by":"task:lead","reply_sid":"sid-a","reply_host":"clouddev""#)
        XCTAssertEqual(t.reply_by, "task:lead")
        XCTAssertEqual(OrgThreadModel.summarySource(t), LinkSource(host: "clouddev", sessionID: "sid-a"))
    }

    func testASessionWithNoHostIsLookedUpOnTap() throws {
        let t = try thread(#","reply":"x","reply_by":"agent","reply_sid":"sid-a""#)
        XCTAssertEqual(OrgThreadModel.summarySource(t), LinkSource(sessionID: "sid-a"))
        XCTAssertFalse(OrgThreadModel.summarySource(t).hostKnown)
    }

    func testTheLocalHostIsThePrimaryAndKnown() throws {
        let t = try thread(#","reply":"x","reply_by":"agent","reply_sid":"sid-a","reply_host":"__local__""#)
        let source = OrgThreadModel.summarySource(t)
        XCTAssertTrue(source.hostKnown)
        XCTAssertNil(source.host)
        XCTAssertEqual(source.sessionID, "sid-a")
    }

    func testAPersonsSummaryIsThePrimary() throws {
        let t = try thread(#","reply":"x","reply_by":"human""#)
        XCTAssertEqual(OrgThreadModel.summarySource(t), .primary)
    }

    func testASummaryFromBeforeTheWriterWasRecordedIsUnknownNeverTheNodesSession() throws {
        XCTAssertEqual(OrgThreadModel.summarySource(try thread(#","reply":"see /p/a.ts""#)), .unknown)
        // A writer named without its session is no machine either.
        XCTAssertEqual(OrgThreadModel.summarySource(try thread(#","reply":"x","reply_by":"agent""#)), .unknown)
        XCTAssertEqual(OrgThreadModel.summarySource(try thread(#","reply":"x","reply_by":"agent","reply_sid":"  ""#)), .unknown)
    }

    func testAnAnswerOpensOnTheSessionItWasReadFrom() throws {
        let t = try thread(messages: #"""
        [{"id":"tm-1","at":"2026-11-08T10:00:00Z","text":"q","answer":{"text":"a /p/a.ts","at":"2026-11-08T10:01:00Z","sid":"sid-b","host":"olddev"}},
         {"id":"tm-2","at":"2026-11-08T10:02:00Z","text":"q2","answer":{"text":"a2","at":"2026-11-08T10:03:00Z"}}]
        """#)
        XCTAssertEqual(OrgThreadModel.answerSource(t.messages[0].answer), LinkSource(host: "olddev", sessionID: "sid-b"))
        // An answer from before the session was recorded, and no answer at all, name no machine.
        XCTAssertEqual(OrgThreadModel.answerSource(t.messages[1].answer), .unknown)
        XCTAssertEqual(OrgThreadModel.answerSource(nil), .unknown)
    }

    func testAnOpeningPostOpensOnItsWriterAndAPersonsIsThePrimary() throws {
        let node = try thread(#","opener":{"text":"found /p/a.ts","at":"2026-11-08T10:00:00Z","from":"node","by":"task:lead","sid":"sid-c","host":"clouddev"}"#)
        XCTAssertEqual(OrgThreadModel.openerSource(try XCTUnwrap(node.opener)), LinkSource(host: "clouddev", sessionID: "sid-c"))
        let person = try thread(#","opener":{"text":"x","at":"2026-11-08T10:00:00Z","from":"node","by":"human"}"#)
        XCTAssertEqual(OrgThreadModel.openerSource(try XCTUnwrap(person.opener)), .primary)
        let old = try thread(#","opener":{"text":"x","at":"2026-11-08T10:00:00Z","from":"node"}"#)
        XCTAssertEqual(OrgThreadModel.openerSource(try XCTUnwrap(old.opener)), .unknown)
    }

    func testAnExchangeShowsItsOpenersWritersWordsElseItsAnswersWriters() throws {
        let t = try thread(#","opener":{"text":"o","at":"2026-11-08T10:00:00Z","from":"node","by":"agent","sid":"sid-o"}"#,
                           messages: #"[{"id":"tm-1","at":"2026-11-08T10:00:00Z","text":"q","answer":{"text":"a","at":"2026-11-08T10:01:00Z","sid":"sid-a"}}]"#)
        let answered = OrgThreadModel.Exchange(n: 1, messages: t.messages, answer: t.messages[0].answer, opener: nil, known: false)
        let opened = OrgThreadModel.Exchange(n: 0, messages: [], answer: nil, opener: t.opener, known: false)
        XCTAssertEqual(OrgThreadModel.source(of: answered), LinkSource(sessionID: "sid-a"))
        XCTAssertEqual(OrgThreadModel.source(of: opened), LinkSource(sessionID: "sid-o"))
    }

    func testEveryMarkdownBodyOnTheThreadsPageNamesItsWriter() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let text = try String(contentsOf: root.appendingPathComponent("Walnut/Views/Org/OrgThreadsView.swift"), encoding: .utf8)
        // A body built without `.linked(from:)` reads as an empty source: the server would guess the machine.
        let bodies = text.components(separatedBy: "LetterMarkdownBody(markdown:").count - 1
        let linked = text.components(separatedBy: ".linked(from: source)").count - 1
        XCTAssertGreaterThan(bodies, 0)
        XCTAssertEqual(bodies, linked, "a thread card's markdown body names no writer")
        // The folded wrapper takes its source from the call site, never a default that guesses.
        XCTAssertTrue(text.contains("var source: LinkSource = .unknown"))
        for call in text.components(separatedBy: "OrgFoldedMarkdown(markdown:").dropFirst() {
            XCTAssertTrue(call.prefix(200).contains("source:"), "a folded body is drawn with no writer")
        }
    }
}
