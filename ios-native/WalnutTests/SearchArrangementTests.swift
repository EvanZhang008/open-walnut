import XCTest
@testable import Walnut

/// `SearchArrangement`: the Tasks tab answers a query the way the web console's home
/// search does (`web/src/components/tasks/search-relevance.ts`, `arrangeSearchResults`).
///
/// The cases mirror the web's: open hits lead, at most three completed TITLE hits show
/// inline, the other completed hits that show the query wait behind "Completed (N)",
/// and semantic-only hits behind "Related (N)", open ones first. Two rules are the
/// phone's own: the completed semantic-only hits join the end of "Related" (the web
/// reveals them with a Done chip the phone does not have), and a hit on a task the
/// phone does not hold (completed more than 14 days ago) draws from the task the search
/// response carried.
final class SearchArrangementTests: XCTestCase {

    // MARK: - Fixtures

    private func task(
        _ id: String, _ title: String, done: Bool = false, project: String = "",
        completedAt: String? = nil, tags: [String]? = nil
    ) -> WalnutTask {
        WalnutTask(
            id: id, title: title, status: done ? "done" : "todo", phase: done ? "COMPLETE" : "TODO",
            priority: "none", project: project, dueDate: nil, createdAt: nil, updatedAt: nil,
            completedAt: done ? (completedAt ?? "2026-09-01T00:00:00.000Z") : nil,
            starred: nil, pinned: nil, tags: tags, summary: nil
        )
    }

    private func taskRow(_ id: String, _ title: String, snippet: String? = nil, field: String = "title", tier: Double? = nil) -> GlobalSearchResult {
        GlobalSearchResult(type: "task", resultId: id, title: title, snippet: snippet ?? title, score: 0.5,
                           taskId: id, matchField: field, coveredTermHits: tier)
    }

    private func sessionRow(_ owner: String?, _ title: String, snippet: String) -> GlobalSearchResult {
        GlobalSearchResult(type: "session", resultId: owner ?? "sess-\(title.count)", title: title, snippet: snippet,
                           score: 0.4, taskId: owner, matchField: "description")
    }

    private func arrange(
        _ query: String, rows: [GlobalSearchResult]?, carried: [WalnutTask] = [], store: [WalnutTask] = [],
        localDone: [WalnutTask] = [], visible: Set<String> = [], nothingAbove: Bool = false
    ) -> SearchArrangement {
        SearchArrangement.arrange(
            query: query, serverRows: rows, responseTasks: carried, storeTasks: store,
            localDone: localDone, visibleTaskIds: visible, nothingAbove: nothingAbove
        )
    }

    private func ids(_ hits: [SearchHit]) -> [String] { hits.map(\.id) }

    // MARK: - The web's arrangement

    func testOpenHitsLeadCompletedTitleHitsFoldPastThree() {
        let done = (1...5).map { task("d\($0)", "Picnic list \($0)", done: true, completedAt: "2026-09-0\($0)T00:00:00Z") }
        let open = task("o1", "Plan the marina outing")
        let rows = [taskRow("o1", open.title, snippet: "the picnic basket")]
        let a = arrange("picnic", rows: rows, store: [open] + done, localDone: done)

        // Three completed title hits inline, most recently completed first (same title
        // position), then the open server hit that shows the query in its snippet.
        XCTAssertEqual(ids(a.primary), ["d5", "d4", "d3", "o1"])
        XCTAssertEqual(ids(a.completed), ["d2", "d1"])
        XCTAssertTrue(a.related.isEmpty)
    }

    func testTheQueryNearestTheTitleStartRanksFirstAmongCompleted() {
        let late = task("late", "A long pasted prompt that merely mentions invoice", done: true, completedAt: "2026-09-09T00:00:00Z")
        let early = task("early", "Invoice for the boat", done: true, completedAt: "2026-08-01T00:00:00Z")
        let a = arrange("invoice", rows: nil, localDone: [late, early])
        XCTAssertEqual(ids(a.primary), ["early", "late"])
    }

    func testACompletedHitShowingTheQueryOnlyInItsSnippetGoesBehindTheFold() {
        let old = task("old", "Book the tables", done: true)
        let rows = [taskRow("old", old.title, snippet: "…confirmed the picnic venue…", field: "description")]
        let a = arrange("picnic", rows: rows, carried: [old], localDone: [])
        XCTAssertTrue(a.primary.isEmpty)
        XCTAssertEqual(ids(a.completed), ["old"])
    }

    func testSemanticOnlyHitsAreRelatedOpenOnesFirst() {
        let open = task("o", "Weekend lunch by the water")
        let done = task("d", "Outdoor meal ideas", done: true)
        // The completed one ranks first on the server and still follows the open one.
        let rows = [
            taskRow("d", done.title, snippet: done.title, field: "semantic"),
            taskRow("o", open.title, snippet: open.title, field: "semantic"),
        ]
        let a = arrange("picnic", rows: rows, carried: [open, done])
        XCTAssertTrue(a.primary.isEmpty)
        XCTAssertTrue(a.completed.isEmpty, "a completed hit that does not show the query is not a Completed one")
        XCTAssertEqual(ids(a.related), ["o", "d"])
        XCTAssertEqual(a.looseDone, 1)
    }

    func testWithNothingAboveTheFirstNonEmptyFoldIsTheAnswer() {
        let done = task("d", "Book the tables", done: true)
        let rows = [taskRow("d", done.title, snippet: "picnic tables for twelve", field: "note")]
        let shown = arrange("picnic", rows: rows, carried: [done], nothingAbove: true)
        XCTAssertEqual(ids(shown.primary), ["d"])
        XCTAssertTrue(shown.completed.isEmpty)

        let open = task("o", "Weekend lunch by the water")
        let related = arrange("picnic", rows: [taskRow("o", open.title, field: "semantic")], carried: [open], nothingAbove: true)
        XCTAssertEqual(ids(related.primary), ["o"])
        XCTAssertTrue(related.related.isEmpty)

        // With rows above, the folds stay folds.
        let folded = arrange("picnic", rows: rows, carried: [done], nothingAbove: false)
        XCTAssertTrue(folded.primary.isEmpty)
        XCTAssertEqual(ids(folded.completed), ["d"])
    }

    // MARK: - One task, one row

    func testATaskAndItsSessionAreOneHitWithEitherRowsEvidence() {
        let t = task("t-1001", "Weekly sync notes")
        // The task row does not show the query; its session's transcript does.
        let rows = [
            taskRow("t-1001", t.title, snippet: t.title, field: "semantic"),
            sessionRow("t-1001", "sync session", snippet: "…we planned the picnic…"),
        ]
        let a = arrange("picnic", rows: rows, carried: [t])
        XCTAssertEqual(ids(a.primary), ["t-1001"])
        XCTAssertEqual(a.primary.first?.snippet, "…we planned the picnic…", "the snippet that shows the query is the one drawn")
        XCTAssertTrue(a.related.isEmpty)
    }

    func testRowsAboveGetNoSecondCopyAndSaySo() {
        let t = task("t-abcdef123", "Picnic plan")
        let a = arrange("picnic", rows: [taskRow("t-abcdef123", t.title), sessionRow("t-abcdef123", "s", snippet: "picnic")],
                        carried: [t], visible: ["t-abcdef123"])
        XCTAssertTrue(a.isEmpty)
        XCTAssertTrue(a.allOnScreen)

        // A short server id still matches the board's full id (the prefix rule).
        let short = arrange("picnic", rows: [taskRow("t-abcdef", t.title)], carried: [t], visible: ["t-abcdef123"])
        XCTAssertTrue(short.isEmpty)
    }

    func testAPhoneCompletedMatchTheServerAlsoFoundIsOneRow() {
        let done = task("d", "Picnic tables", done: true)
        let a = arrange("picnic", rows: [taskRow("d", done.title)], carried: [done], localDone: [done])
        XCTAssertEqual(ids(a.primary), ["d"])
        XCTAssertFalse(a.allOnScreen)
    }

    func testMemoryRowsAndSessionsNoTaskOwnsHaveNoRowHere() {
        let rows = [
            GlobalSearchResult(type: "memory", resultId: nil, title: "picnic memory", snippet: "picnic", score: 1),
            sessionRow(nil, "orphan picnic", snippet: "picnic"),
        ]
        let a = arrange("picnic", rows: rows)
        XCTAssertTrue(a.isEmpty)
        XCTAssertFalse(a.allOnScreen)
    }

    // MARK: - Which copy of a task is drawn

    func testTheLiveCopyWinsOverTheCarriedOne() {
        let carried = task("t", "Picnic", done: true)
        let live = task("t", "Picnic")   // reopened since the search answered
        let a = arrange("picnic", rows: [taskRow("t", "Picnic")], carried: [carried], store: [live])
        XCTAssertEqual(a.primary.first?.task?.isDone, false)
    }

    func testAHitNoOneHoldsStillDrawsFromItsRow() {
        // An older server (no `tasks`), or the companion answering while the Mac is away.
        let a = arrange("picnic", rows: [taskRow("t-x", "Picnic day", snippet: "Picnic day")])
        XCTAssertEqual(ids(a.primary), ["t-x"])
        XCTAssertNil(a.primary.first?.task)
        XCTAssertEqual(a.primary.first?.row?.title, "Picnic day")
    }

    // MARK: - Before the server answers

    func testThePhonesCompletedMatchesShowBeforeAndWithoutTheServer() {
        let done = task("d", "Renew the boat license", done: true, project: "Marina")
        let byProject = arrange("marina", rows: nil, localDone: [done])
        XCTAssertEqual(ids(byProject.primary), ["d"], "a project hit is a quick-lane hit")
        let byTag = arrange("errand", rows: nil, localDone: [task("g", "Pick up parts", done: true, tags: ["errand"])])
        XCTAssertEqual(ids(byTag.primary), ["g"], "a tag hit is a quick-lane hit")
        XCTAssertTrue(arrange("  ", rows: nil, localDone: [done]).isEmpty)
    }

    // MARK: - Evidence (twin of serverRowShowsQuery)

    func testEvidenceRules() {
        let terms = SearchRelevance.queryTerms("dockhub sync")
        XCTAssertTrue(SearchRelevance.rowShowsQuery(taskRow("a", "Dock Hub KB sync"), terms: terms),
                      "a name typed as one word shows in a row that writes it as two")
        XCTAssertTrue(SearchRelevance.rowShowsQuery(taskRow("a", "Opus 4.8 upgrade"), terms: SearchRelevance.queryTerms("opus-4-8")))
        XCTAssertFalse(SearchRelevance.rowShowsQuery(taskRow("a", "Dock maintenance"), terms: terms))
        XCTAssertTrue(SearchRelevance.rowShowsQuery(taskRow("a", "Dock maintenance", field: "note", tier: 4), terms: terms),
                      "full keyword coverage counts though the snippet cannot show every term")
        XCTAssertTrue(SearchRelevance.rowShowsQuery(taskRow("a", "anything", field: "id"), terms: terms),
                      "an identifier match answers exactly what was typed")
    }

    func testQueryTermsDropOneLetterNoiseAndFoldWidth() {
        XCTAssertEqual(SearchRelevance.queryTerms("a picnic"), ["picnic"])
        XCTAssertEqual(SearchRelevance.queryTerms("a"), ["a"])
        // Full-width "ＡＢＣ　１２" (an input method in full-width mode).
        XCTAssertEqual(SearchRelevance.queryTerms("\u{FF21}\u{FF22}\u{FF23}\u{3000}\u{FF11}\u{FF12}"), ["abc", "12"])
        // CJK text passes through untouched.
        XCTAssertEqual(SearchRelevance.queryTerms("\u{5348}\u{9910} plan"), ["\u{5348}\u{9910}", "plan"])
    }

    func testASnippetLosesItsMarkdownMarkers() {
        XCTAssertEqual(GlobalSearchSection.plainSnippet("…**User:** the `search` box, __now__…"), "…User: the search box, now…")
        XCTAssertEqual(GlobalSearchSection.plainSnippet("2 * 3 and snake_case"), "2 * 3 and snake_case")
    }

    // MARK: - The request

    func testTheQueryValueKeepsReservedCharacters() {
        XCTAssertEqual(WalnutAPI.queryValue("C++ & more #1 a=b?"), "C%2B%2B%20%26%20more%20%231%20a%3Db%3F")
        XCTAssertEqual(WalnutAPI.queryValue("\u{5348}\u{9910}"), "%E5%8D%88%E9%A4%90")
    }

    func testTheResponseDecodesItsTasksAndOfflineFlag() throws {
        let json = """
        { "results": [ { "type": "session", "sessionId": "s1", "taskId": "t1", "title": "x",
                         "matchField": "description", "coveredTermHits": 4 } ],
          "tasks": [ { "id": "t1", "title": "Old picnic", "status": "done", "phase": "COMPLETE",
                       "priority": "none", "project": "", "created_at": "2026-01-01T00:00:00Z",
                       "updated_at": "2026-01-02T00:00:00Z", "completed_at": "2026-01-02T00:00:00Z" } ],
          "offline": true }
        """
        let response = try JSONDecoder().decode(GlobalSearchResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.results.first?.ownerTaskId, "t1")
        XCTAssertEqual(response.results.first?.coveredTermHits, 4)
        XCTAssertEqual(response.tasks?.first?.isDone, true)
        XCTAssertEqual(response.offline, true)
    }
}
