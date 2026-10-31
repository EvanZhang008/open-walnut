import SwiftUI
import UIKit
import XCTest
@testable import Walnut

/// Every task mentioned in chat text reads as the task's CURRENT title and opens the
/// task (`TaskMentions`). The user's ask: "make all the task if it is referenced in
/// the chat [show its] name so that user can click". Same rules as the web console's
/// `web/src/utils/task-id-shape.ts`.
@MainActor
final class TaskMentionsTests: XCTestCase {
    private let resolver = TaskMentionResolver.shared

    private static let loginID = "mvu0ubnq-a02d"
    private static let releaseID = "mvkghc5v-278c"
    private static let syncedID = "2ac88910-c19a-566b-a690-10048f4e1d02"

    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
        resolver.resetForTesting()
        resolver.update([
            Self.loginID: "Fix the login page",
            Self.releaseID: "Ship the release notes",
            Self.syncedID: "Synced from the calendar",
            // Two ids sharing a first segment: that segment names neither.
            "abc1234x-0001": "First twin",
            "abc1234x-0002": "Second twin",
            // A first segment with no digit (base36 time is all letters ~1 in 14 times).
            "mpwidref-7c2e": "Letters only",
        ])
    }

    override func tearDown() {
        resolver.resetForTesting()
        MarkdownParser.resetCacheForTesting()
        super.tearDown()
    }

    // MARK: - Helpers

    private func plain(_ s: AttributedString) -> String { String(s.characters) }

    private func taskLinks(_ s: AttributedString) -> [(text: String, id: String)] {
        s.runs.compactMap { run -> (text: String, id: String)? in
            guard let url = run.link, let id = TaskMentionLink.taskID(from: url) else { return nil }
            return (String(s[run.range].characters), id)
        }
    }

    private func paragraphText(_ markdown: String) -> AttributedString? {
        for block in MarkdownParser.parse(markdown) {
            if case .paragraph(let text) = block.kind { return text }
        }
        return nil
    }

    // MARK: - <task-ref/>

    func testTaskRefWithAKnownIdBecomesTheTitleAsALink() {
        let out = MarkdownParser.inline(
            #"Created <task-ref id="mvu0ubnq-a02d" label="An old label"/> today."#)
        XCTAssertEqual(plain(out), "Created Fix the login page today.")
        let links = taskLinks(out)
        XCTAssertEqual(links.count, 1)
        XCTAssertEqual(links.first?.text, "Fix the login page")
        XCTAssertEqual(links.first?.id, Self.loginID)
        let linked = out.runs.first { $0.link != nil }
        XCTAssertEqual(linked?.inlinePresentationIntent?.contains(.stronglyEmphasized), true,
                       "a mention reads as a name: semibold")
    }

    func testTaskRefWithAnEmptyIdIsPlainTextNeverALink() {
        let out = MarkdownParser.inline(#"See <task-ref id="" label="Some label"/> here"#)
        XCTAssertEqual(plain(out), "See Some label here")
        XCTAssertTrue(out.runs.allSatisfy { $0.link == nil })
        let empty = MarkdownParser.inline(#"a <task-ref id="" label=""/> b"#)
        XCTAssertEqual(plain(empty), "a  b")
        XCTAssertTrue(empty.runs.allSatisfy { $0.link == nil })
    }

    func testTaskRefWithAnUnknownIdShowsItsLabelWithoutALink() {
        let out = MarkdownParser.inline(#"Filed <task-ref id="mzzzzzzz-ffff" label="Gone task"/>."#)
        XCTAssertEqual(plain(out), "Filed Gone task.")
        XCTAssertTrue(taskLinks(out).isEmpty)
        let noLabel = MarkdownParser.inline(#"Filed <task-ref id="mzzzzzzz-ffff"/>."#)
        XCTAssertEqual(plain(noLabel), "Filed mzzzzzzz-ffff.")
        XCTAssertTrue(taskLinks(noLabel).isEmpty)
    }

    func testTitleWithMarkdownCharactersReadsAsWritten() {
        resolver.update([Self.loginID: "Fix *the* [login] page_v2"])
        let out = MarkdownParser.inline(#"<task-ref id="mvu0ubnq-a02d"/>"#)
        XCTAssertEqual(plain(out), "Fix *the* [login] page_v2")
        XCTAssertEqual(taskLinks(out).first?.id, Self.loginID)
    }

    func testLegacyBracketRefFollowsTheSameRule() {
        let known = MarkdownParser.inline("Done: [mvu0ubnq-a02d|Old title]")
        XCTAssertEqual(plain(known), "Done: Fix the login page")
        XCTAssertEqual(taskLinks(known).first?.id, Self.loginID)
        let unknown = MarkdownParser.inline("Done: [mzzzzzzz-ffff|Kept label]")
        XCTAssertEqual(plain(unknown), "Done: Kept label")
        XCTAssertTrue(taskLinks(unknown).isEmpty)
    }

    func testSessionRefKeepsItsBoldLabel() {
        let out = MarkdownParser.inline(#"see <session-ref id="abc-123" label="The run"/>"#)
        XCTAssertEqual(plain(out), "see The run")
        XCTAssertTrue(taskLinks(out).isEmpty)
    }

    // MARK: - Bare ids

    func testBareKnownShortIdBecomesTheTitleLinkedToTheFullId() {
        let out = MarkdownParser.inline("Confirmed by mvu0ubnq-a02d, then merged.")
        XCTAssertEqual(plain(out), "Confirmed by Fix the login page, then merged.")
        XCTAssertEqual(taskLinks(out).map { $0.id }, [Self.loginID])
    }

    func testBareUnknownIdsStayAsWritten() {
        let text = "commit 9f8e7d6c5b4a and mzzzzzzz-ffff and 0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"
        let out = MarkdownParser.inline(text)
        XCTAssertEqual(plain(out), text)
        XCTAssertTrue(taskLinks(out).isEmpty)
    }

    func testFirstSegmentPrefixResolvesWhenExactlyOneIdHasIt() {
        let short = MarkdownParser.inline("task mvkghc5v is done")
        XCTAssertEqual(plain(short), "task Ship the release notes is done")
        XCTAssertEqual(taskLinks(short).map { $0.id }, [Self.releaseID])
        let uuidHead = MarkdownParser.inline("synced 2ac88910 and 2ac88910-c19a")
        XCTAssertEqual(plain(uuidHead), "synced Synced from the calendar and Synced from the calendar")
        XCTAssertEqual(taskLinks(uuidHead).map { $0.id }, [Self.syncedID, Self.syncedID])
        let full = MarkdownParser.inline("synced \(Self.syncedID).")
        XCTAssertEqual(taskLinks(full).map { $0.id }, [Self.syncedID])
    }

    func testAmbiguousPrefixIsNotALink() {
        let out = MarkdownParser.inline("twins abc1234x here")
        XCTAssertEqual(plain(out), "twins abc1234x here")
        XCTAssertTrue(taskLinks(out).isEmpty)
    }

    func testAllLetterPrefixOfAKnownIdLinks() {
        let out = MarkdownParser.inline("reviewed by mpwidref today")
        XCTAssertEqual(plain(out), "reviewed by Letters only today")
        XCTAssertEqual(taskLinks(out).map { $0.id }, ["mpwidref-7c2e"])
        XCTAssertTrue(TaskMentions.isPrefixToken("mpwidref"))
        XCTAssertTrue(TaskMentions.isPrefixToken("mvkghc5v"))
    }

    func testWordsNumbersAndShortTokensThatPrefixNothingStayText() {
        // An all-letter word that prefixes no id; all digits; seven characters that
        // start an id but stop short of its dash; six characters.
        let text = "something 12345678 and mvu0ubn and mvu0ub"
        let out = MarkdownParser.inline(text)
        XCTAssertEqual(plain(out), text)
        XCTAssertTrue(taskLinks(out).isEmpty)
        XCTAssertTrue(TaskMentions.isPrefixToken("something"), "a candidate, but it resolves to nothing")
        XCTAssertFalse(TaskMentions.isPrefixToken("12345678"))
        XCTAssertFalse(TaskMentions.isPrefixToken("ab12cd"))
    }

    func testIdInsidePathsFileNamesAndLongerTokensIsNotATaskLink() {
        for text in [
            "/a/mvu0ubnq-a02d/x",
            "open notes/mvu0ubnq-a02d.md now",
            "see https://example.com/t/mvu0ubnq-a02d",
            "mail mvu0ubnq-a02d@example.com",
            "branch wt/mvu0ubnq-a02d-base",
            "ref #mvu0ubnq-a02d",
        ] {
            let out = MarkdownParser.inline(text)
            XCTAssertEqual(plain(out), text, "the id inside \(text.debugDescription) must keep its text")
            XCTAssertTrue(taskLinks(out).isEmpty, "no task link inside \(text.debugDescription)")
        }
    }

    func testIdAtTheEndOfASentenceStillLinks() {
        let out = MarkdownParser.inline("It was mvu0ubnq-a02d.")
        XCTAssertEqual(plain(out), "It was Fix the login page.")
    }

    func testCJKProseAroundAnIdStillLinks() {
        // Test data: "task" before and "is done" after, in Chinese, touching the id.
        let out = MarkdownParser.inline("\u{4EFB}\u{52A1}mvu0ubnq-a02d\u{5DF2}\u{5B8C}\u{6210}")
        XCTAssertEqual(plain(out), "\u{4EFB}\u{52A1}Fix the login page\u{5DF2}\u{5B8C}\u{6210}")
        XCTAssertEqual(taskLinks(out).map { $0.id }, [Self.loginID])
    }

    func testWholeCodeSpanBecomesTheTitleLinkAndLongerCodeIsLeftAlone() {
        let whole = MarkdownParser.inline("see `mvu0ubnq-a02d` now")
        XCTAssertEqual(plain(whole), "see Fix the login page now")
        XCTAssertEqual(taskLinks(whole).map { $0.id }, [Self.loginID])
        let linked = whole.runs.first { $0.link != nil }
        XCTAssertNotEqual(linked?.inlinePresentationIntent?.contains(.code), true,
                          "the title is a name, not code")
        let command = MarkdownParser.inline("run `walnut task show mvu0ubnq-a02d` now")
        XCTAssertEqual(plain(command), "run walnut task show mvu0ubnq-a02d now")
        XCTAssertTrue(taskLinks(command).isEmpty)
    }

    func testFencedCodeKeepsTheId() {
        let blocks = MarkdownParser.parse("```\nwalnut task show mvu0ubnq-a02d\n```")
        guard case .code(_, let text)? = blocks.first?.kind else { return XCTFail("expected a code block") }
        XCTAssertTrue(text.contains("mvu0ubnq-a02d"))
    }

    // MARK: - Titles the org reads

    func testMainReadsAsCEOAndALeadAsItsVP() {
        XCTAssertEqual(TaskMentions.shownTitle("Main", orgRole: "main"), "CEO")
        XCTAssertEqual(TaskMentions.shownTitle("Walnut lead", orgRole: "lead"), "Walnut VP")
        XCTAssertEqual(TaskMentions.shownTitle("Walnut lead", orgRole: nil), "Walnut lead")
    }

    func testTasksStoreFeedsTheTable() {
        let store = TasksStore()
        store.feedsTaskMentions = false
        store.tasks = [
            WalnutTask(id: "mrole001-0a0a", title: "Main", status: "todo", phase: "TODO",
                       priority: "none", project: "", dueDate: nil, createdAt: nil, updatedAt: nil,
                       completedAt: nil, starred: nil, pinned: nil, tags: nil, summary: nil,
                       orgRole: "main"),
        ]
        store.syncTaskMentionsNow()
        XCTAssertEqual(resolver.title(for: "mrole001-0a0a"), "CEO")
        XCTAssertNil(resolver.title(for: Self.loginID), "the store's list replaces the table")
    }

    // MARK: - Freshness

    func testATitleChangeReRendersThroughTheParseCache() {
        let markdown = "Status of mvu0ubnq-a02d today"
        XCTAssertEqual(paragraphText(markdown).map { String($0.characters) }, "Status of Fix the login page today")
        let before = resolver.version
        var renamed = [
            Self.loginID: "Login page fixed",
            Self.releaseID: "Ship the release notes",
            Self.syncedID: "Synced from the calendar",
        ]
        XCTAssertTrue(resolver.update(renamed))
        XCTAssertNotEqual(resolver.version, before)
        XCTAssertEqual(paragraphText(markdown).map { String($0.characters) }, "Status of Login page fixed today",
                       "a cached render of the old title must not be served after a rename")
        // A task nobody mentioned comes and goes: nothing rendered changes.
        let quiet = resolver.version
        renamed["mnew0001-0b0b"] = "Unrelated new task"
        XCTAssertFalse(resolver.update(renamed))
        XCTAssertEqual(resolver.version, quiet)
    }

    func testAMentionedPrefixReactsWhenASecondIdSharesIt() {
        XCTAssertEqual(taskLinks(MarkdownParser.inline("task mvkghc5v")).map { $0.id }, [Self.releaseID])
        let before = resolver.version
        XCTAssertTrue(resolver.update([
            Self.releaseID: "Ship the release notes",
            "mvkghc5v-9999": "A twin",
        ]))
        XCTAssertNotEqual(resolver.version, before)
        XCTAssertTrue(taskLinks(MarkdownParser.inline("task mvkghc5v")).isEmpty)
    }

    func testTheTimelineRebuildsAMemoizedRowWhenTheTitleChanges() async {
        let engine = TimelineLayoutActor()
        let message = ChatMessage(id: "m-1", role: "assistant", text: "Done: mvu0ubnq-a02d",
                                  createdAt: "2026-10-31T06:00:00Z", kind: nil)
        func input() -> TimelineInput {
            TimelineInput(messages: [message], streaming: false, liveText: "",
                          liveTextTruncated: false, activity: nil, showLoadEarlier: false,
                          width: 393, expandedRowIDs: [])
        }
        func texts(_ snapshot: TimelineSnapshot) -> [String] {
            snapshot.rows.compactMap { row -> String? in
                if case .text(let attributed) = row.content { return attributed.string }
                return nil
            }
        }
        let first = await engine.buildSnapshot(input())
        XCTAssertTrue(texts(first).contains("Done: Fix the login page"), "\(texts(first))")
        resolver.update([Self.loginID: "Login page fixed"])
        // Same message, same width: only the mention table moved, and the memo must
        // not replay the row built against the old title.
        let second = await engine.buildSnapshot(input())
        XCTAssertTrue(texts(second).contains("Done: Login page fixed"), "\(texts(second))")
    }

    // MARK: - Tapping

    func testTimelineTextCarriesATaskLinkWithoutAnUnderline() {
        let out = TimelineTextStyler.inlineText(#"Filed <task-ref id="mvu0ubnq-a02d" label="x"/>"#)
        XCTAssertEqual(out.string, "Filed Fix the login page")
        let at = (out.string as NSString).range(of: "Fix").location
        let url = out.attribute(.link, at: at, effectiveRange: nil) as? URL
        XCTAssertEqual(url.flatMap(TaskMentionLink.taskID(from:)), Self.loginID)
        XCTAssertNil(out.attribute(.underlineStyle, at: at, effectiveRange: nil))
    }

    func testALinkOnlyChangeStillReloadsTheCell() {
        let label = NSAttributedString(string: "Done: Fix the login page")
        let linked = NSMutableAttributedString(attributedString: label)
        linked.addAttribute(.link, value: TaskMentionLink.url(for: Self.loginID)!,
                            range: NSRange(location: 6, length: 18))
        XCTAssertNotEqual(TimelineRowContent.text(label).contentKey,
                          TimelineRowContent.text(linked).contentKey)
    }

    func testTheControllerRoutesATaskLinkToOpenTask() {
        let controller = TimelineCollectionController()
        var opened: [String] = []
        controller.onAction = { action in
            if case .openTask(let id) = action { opened.append(id) }
        }
        controller.timelineCell(didRequest: .openURL(TaskMentionLink.url(for: Self.loginID)!))
        XCTAssertEqual(opened, [Self.loginID])
    }

    func testTaskLinkRoundTripsItsId() {
        for id in [Self.loginID, Self.syncedID] {
            let url = TaskMentionLink.url(for: id)
            XCTAssertEqual(url?.scheme, "walnut-task")
            XCTAssertEqual(url.flatMap(TaskMentionLink.taskID(from:)), id)
        }
        XCTAssertNil(TaskMentionLink.url(for: ""))
        XCTAssertNil(TaskMentionLink.taskID(from: URL(string: "https://example.com/task/x")!))
    }
}
