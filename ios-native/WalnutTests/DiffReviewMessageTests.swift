import XCTest
@testable import Walnut

/// The review a phone sends reads exactly as the web Changed tab's: both sides
/// are held to tests/fixtures/diff-review-messages.json (the web twin is
/// tests/web/diff-view/diff-review-message-parity.test.ts). And the review itself
/// is words the person wrote: it survives the app ending, and a send takes only
/// the comments it carried.
@MainActor
final class DiffReviewMessageTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Comment: Decodable { let loc: String; let code: String; let comment: String }
        struct Case: Decodable {
            let name: String
            let comments: [Comment]
            let expected: String
            let expectedEach: [String]
        }
        let cases: [Case]
    }

    private static let fixtureURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("tests/fixtures/diff-review-messages.json")

    override func setUp() {
        super.setUp()
        DurableStore.removeAllForTesting()
    }

    override func tearDown() {
        DurableStore.removeAllForTesting()
        super.tearDown()
    }

    func testMessagesMatchTheSharedFixture() throws {
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: Self.fixtureURL))
        XCTAssertGreaterThan(fixture.cases.count, 2)
        for c in fixture.cases {
            let comments = c.comments.enumerated().map { i, x in
                DiffReviewComment(id: "c\(i)", filePath: "/r/\(x.loc)", relPath: x.loc, compareKey: "session",
                                  lineKeys: [], loc: x.loc, code: x.code, comment: x.comment, createdAt: Date())
            }
            XCTAssertEqual(DiffReviewMessage.review(comments), c.expected, c.name)
            XCTAssertEqual(c.comments.map { DiffReviewMessage.comment(loc: $0.loc, code: $0.code, comment: $0.comment) },
                           c.expectedEach, c.name)
        }
    }

    func testLocNamesTheNewLineOrTheOldOneForARemovedLine() {
        let added = DiffLine(kind: .added, oldNumber: nil, newNumber: 15, text: "a")
        let removed = DiffLine(kind: .removed, oldNumber: 9, newNumber: nil, text: "b")
        let context = DiffLine(kind: .context, oldNumber: 12, newNumber: 20, text: "c")
        XCTAssertEqual(DiffReviewMessage.loc(relPath: "src/x.ts", lines: [added]), "src/x.ts:L15")
        XCTAssertEqual(DiffReviewMessage.loc(relPath: "src/x.ts", lines: [removed]), "src/x.ts:L9")
        XCTAssertEqual(DiffReviewMessage.loc(relPath: "src/x.ts", lines: [added, context]), "src/x.ts:L15-L20")
        // A range whose ends read the same number stays one line.
        let sameEnd = DiffLine(kind: .removed, oldNumber: 15, newNumber: nil, text: "d")
        XCTAssertEqual(DiffReviewMessage.loc(relPath: "src/x.ts", lines: [added, sameEnd]), "src/x.ts:L15")
        XCTAssertEqual(DiffReviewMessage.loc(relPath: "src/x.ts", lines: []), "src/x.ts")
    }

    func testTheReviewSurvivesTheAppEndingAndASendTakesOnlyWhatItCarried() {
        let file = SessionChangedFile(filePath: "/r/src/a.ts", relPath: "src/a.ts", status: "modified")
        let line = DiffLine(kind: .added, oldNumber: nil, newNumber: 3, text: "let x = 1")
        let first = DiffReview(sessionId: "s1")
        let a = first.add(file: file, compare: .session, lines: [line], comment: "Name it better")
        XCTAssertEqual(a.loc, "src/a.ts:L3")
        XCTAssertEqual(a.code, "let x = 1")

        // A new page (or a relaunch) reads the same review back.
        let again = DiffReview(sessionId: "s1")
        XCTAssertEqual(again.comments.map(\.comment), ["Name it better"])
        XCTAssertEqual(again.count(onFile: "/r/src/a.ts", compareKey: "session"), 1)
        XCTAssertEqual(again.comments.first?.compare, .session, "the comment keeps its comparison")
        XCTAssertTrue(DiffReview(sessionId: "s2").comments.isEmpty, "another session's review is its own")

        // A comment added while the send was out stays after it.
        let sentBatch = again.comments
        let late = again.add(file: file, compare: .session, lines: [line], comment: "And test it")
        again.removeSent(sentBatch)
        XCTAssertEqual(again.comments.map(\.id), [late.id])
        XCTAssertEqual(DiffReview(sessionId: "s1").comments.map(\.id), [late.id])

        // x on a card, then Undo: back where it stood, and on disk.
        let other = again.add(file: file, compare: .session, lines: [line], comment: "Second")
        again.remove(late.id)
        again.restore(late, at: 0)
        XCTAssertEqual(DiffReview(sessionId: "s1").comments.map(\.id), [late.id, other.id])
        again.restore(late, at: 0)
        XCTAssertEqual(again.comments.count, 2, "a second Undo adds nothing")
        again.remove(other.id)

        again.edit(late.id, comment: "And add a test")
        XCTAssertEqual(DiffReview(sessionId: "s1").comments.first?.comment, "And add a test")
        again.discardAll()
        XCTAssertTrue(DiffReview(sessionId: "s1").comments.isEmpty)
    }

    func testCardsShowOnlyOnTheComparisonTheyWereLeftOn() {
        let file = SessionChangedFile(filePath: "/r/a.ts", relPath: "a.ts", status: "modified")
        let line = DiffLine(kind: .context, oldNumber: 1, newNumber: 1, text: "x")
        let review = DiffReview(sessionId: "s3")
        review.add(file: file, compare: .session, lines: [line], comment: "one")
        review.add(file: file, compare: .branch(ref: nil), lines: [line], comment: "two")
        XCTAssertEqual(review.comments(onFile: "/r/a.ts", compareKey: "session").map(\.comment), ["one"])
        XCTAssertEqual(review.comments(onFile: "/r/a.ts", compareKey: "branch:").map(\.comment), ["two"])
        // The list's count is the comparison's too: one that says 1 must open on a card.
        XCTAssertEqual(review.count(onFile: "/r/a.ts", compareKey: "session"), 1)
        XCTAssertEqual(review.count(onFile: "/r/a.ts", compareKey: "uncommitted"), 0)
    }

    /// Every fixture message, drawn in the sender's own bubble, keeps its quoted
    /// lines apart in the code font: an inline-only read had joined them into one.
    func testASentReviewKeepsItsQuotedLinesInTheBubble() throws {
        let data = try Data(contentsOf: Self.fixtureURL)
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        for c in fixture.cases {
            for (message, comment) in zip(c.expectedEach, c.comments) where message.contains("```") {
                let drawn = TimelineTextStyler.bubbleText(message)
                XCTAssertFalse(drawn.string.contains("```"), "\(c.name): the fence marks show")
                let codeLines = comment.code.components(separatedBy: "\n")
                for line in codeLines {
                    XCTAssertTrue(drawn.string.components(separatedBy: "\n").contains(line),
                                  "\(c.name): \(line) is not a line of its own")
                }
                let at = (drawn.string as NSString).range(of: codeLines[0])
                let font = drawn.attribute(.font, at: at.location, effectiveRange: nil) as? UIFont
                XCTAssertTrue(font?.fontDescriptor.symbolicTraits.contains(.traitMonoSpace) == true,
                              "\(c.name): the code is not in the code font")
                XCTAssertTrue(drawn.string.hasSuffix(comment.comment), "\(c.name): the comment is lost")
                // One panel behind the block, not a highlight under each run of words.
                XCTAssertNotNil(drawn.attribute(.timelineCodeBlock, at: at.location, effectiveRange: nil))
                XCTAssertNil(drawn.attribute(.backgroundColor, at: at.location, effectiveRange: nil))
            }
        }
        // A fence never closed reads as the text it is.
        XCTAssertEqual(TimelineTextStyler.bubbleText("see ```\nnot code").string, "see ```\nnot code")
    }

    /// A slow send and a second tap (or the sheet closed and opened again): one
    /// message goes, and the comments it carried leave the review once.
    func testASecondSendWhileOneIsOutSendsNothing() async {
        let review = DiffReview(sessionId: "send-once-\(UUID().uuidString)")
        let file = SessionChangedFile(filePath: "/r/a.ts", relPath: "a.ts", status: "modified")
        review.add(file: file, compare: .session, lines: [DiffLine(kind: .added, oldNumber: nil, newNumber: 1, text: "x")],
                   comment: "one")
        var sent: [String] = []
        let slow: (String) async -> ReviewSendResult = { text in
            sent.append(text)
            try? await Task.sleep(for: .milliseconds(300))
            return .delivered
        }
        let first = Task { await review.sendAll(using: slow) }
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(review.sending)
        let second = await review.sendAll(using: slow)
        XCTAssertNil(second, "a second send while one is out starts nothing")
        let firstResult = await first.value
        XCTAssertEqual(firstResult, .delivered)
        XCTAssertEqual(sent.count, 1)
        XCTAssertFalse(review.sending)
        XCTAssertTrue(review.comments.isEmpty)
        let afterEmpty = await review.sendAll(using: slow)
        XCTAssertNil(afterEmpty, "an empty review sends nothing")
    }

    /// Offline, the conversation holds the message in a bubble that lives only in
    /// memory: the review keeps its comments (on disk) until the agent has it, never
    /// sends them a second time meanwhile, and lets them go again once no bubble does.
    func testAHeldSendKeepsItsCommentsUntilDelivered() async {
        let key = "held-\(UUID().uuidString)"
        let review = DiffReview(sessionId: key)
        let file = SessionChangedFile(filePath: "/r/a.ts", relPath: "a.ts", status: "modified")
        let line = DiffLine(kind: .added, oldNumber: nil, newNumber: 1, text: "x")
        review.add(file: file, compare: .session, lines: [line], comment: "one")
        review.add(file: file, compare: .session, lines: [line], comment: "two")
        var sends = 0
        let held = await review.sendAll { _ in sends += 1; return .held(messageID: "qm-1") }
        XCTAssertEqual(held, .held(messageID: "qm-1"))
        XCTAssertEqual(review.comments.count, 2, "a held send drops nothing")
        XCTAssertTrue(review.unsent.isEmpty)
        XCTAssertEqual(DiffReview(sessionId: key).comments.compactMap(\.heldBy), ["qm-1", "qm-1"], "kept on disk, marked")
        let again = await review.sendAll { _ in sends += 1; return .delivered }
        XCTAssertNil(again, "held comments are not sent a second time")
        XCTAssertEqual(sends, 1)

        // Still waiting: nothing changes. An edit makes that one a new comment.
        review.reconcile { _ in .waiting }
        XCTAssertEqual(review.comments.count, 2)
        review.edit(review.comments[1].id, comment: "two, better")
        XCTAssertEqual(review.unsent.map(\.comment), ["two, better"])

        // Delivered: what it carried goes; the edited one stays to be sent.
        review.reconcile { $0 == "qm-1" ? .delivered : .waiting }
        XCTAssertEqual(review.comments.map(\.comment), ["two, better"])

        // Saving a held comment unchanged keeps it held (no second send).
        _ = await review.sendAll { _ in .held(messageID: "qm-3") }
        review.edit(review.comments[0].id, comment: "two, better")
        XCTAssertTrue(review.unsent.isEmpty, "an unchanged save is no new comment")
        // This phone cannot tell: they stay held until the person sends them again.
        review.reconcile { _ in .unknown }
        XCTAssertTrue(review.unsent.isEmpty)
        review.release(["qm-3"])
        XCTAssertEqual(review.unsent.map(\.comment), ["two, better"])

        // A bubble deleted: the comments can go again.
        _ = await review.sendAll { _ in .held(messageID: "qm-2") }
        review.reconcile { _ in .notSent }
        XCTAssertEqual(review.unsent.map(\.comment), ["two, better"])
        let none = await review.sendAll { _ in .notSent }
        XCTAssertEqual(none, .notSent)
        XCTAssertEqual(review.comments.count, 1, "not sent: everything stays")
        review.discardAll()
    }

    /// An edit made while the send is out is not lost when the send returns.
    func testAnEditDuringASendStays() async {
        let review = DiffReview(sessionId: "edit-\(UUID().uuidString)")
        let file = SessionChangedFile(filePath: "/r/a.ts", relPath: "a.ts", status: "modified")
        let made = review.add(file: file, compare: .session,
                              lines: [DiffLine(kind: .added, oldNumber: nil, newNumber: 1, text: "x")], comment: "old")
        let send = Task {
            await review.sendAll { _ in
                try? await Task.sleep(for: .milliseconds(200))
                return .delivered
            }
        }
        try? await Task.sleep(for: .milliseconds(50))
        review.edit(made.id, comment: "new")
        _ = await send.value
        XCTAssertEqual(review.comments.map(\.comment), ["new"], "the sent version went, the new words stayed")
        review.discardAll()
    }
}
