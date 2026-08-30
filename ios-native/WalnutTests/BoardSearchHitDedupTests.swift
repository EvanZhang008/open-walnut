import XCTest
@testable import Walnut

/// `BoardSearchHitDedup` — one task, one row, while searching the Tasks tab.
///
/// # The defect, as measured on the shipping build (2026-08-29 review, item 4)
///
/// With a query typed, the SAME task appeared three times in one viewport: once as its
/// live board row (`board.row.<taskId>`), and twice under "Server Search". Both server
/// rows came from one `/api/search` response, which answers a `type: "task"` hit AND a
/// `type: "session"` hit for the session that task owns. That is deliberate on the
/// server (a session hit carries `taskId` because "which TASK did X?" is the question
/// users ask), and the iOS decoder folds `id ?? taskId ?? sessionId` into `resultId` —
/// so the two rows arrive holding the same task id, differing only in `type`.
/// `GlobalSearchResult.id` is `"\(type)|\(resultId)"`, which is exactly why `ForEach`
/// was happy to draw both.
///
/// # Why the rule is a pure function
///
/// It is a ranking/identity decision with several edge cases (short ids, session hits
/// with no owning task, memory hits that are not about a task at all) and none of them
/// are observable from a view body. The view now renders what this returns and nothing
/// else.
final class BoardSearchHitDedupTests: XCTestCase {

    // MARK: - Fixtures

    private func taskHit(_ id: String?, title: String = "Wire the board chips") -> GlobalSearchResult {
        GlobalSearchResult(type: "task", resultId: id, title: title, snippet: "…", score: 0.9)
    }

    private func sessionHit(_ id: String?, title: String = "board chips session") -> GlobalSearchResult {
        GlobalSearchResult(type: "session", resultId: id, title: title, snippet: "…", score: 0.8)
    }

    private func memoryHit(_ title: String) -> GlobalSearchResult {
        GlobalSearchResult(type: "memory", resultId: nil, title: title, snippet: "…", score: 0.5)
    }

    private func types(_ hits: [GlobalSearchResult]) -> [String] { hits.map(\.type) }

    // MARK: - The reported triple listing

    /// The exact viewport from the review: a task with a live board row, and both of
    /// the server's copies of it. The board row wins; the server section draws nothing.
    func testATaskWithABoardRowGetsNoServerRowAtAll() {
        let hits = [sessionHit("t-1001"), taskHit("t-1001")]
        let kept = BoardSearchHitDedup.visibleHits(hits, visibleTaskIds: ["t-1001"])
        XCTAssertTrue(
            kept.isEmpty,
            "the task is already on screen as board.row.t-1001 — \(kept.count) server rows survived"
        )
    }

    /// One task on screen, whichever way the response is ordered.
    func testTheDropSurvivesEitherOrderOfThePair() {
        for hits in [[sessionHit("t-1001"), taskHit("t-1001")], [taskHit("t-1001"), sessionHit("t-1001")]] {
            XCTAssertTrue(BoardSearchHitDedup.visibleHits(hits, visibleTaskIds: ["t-1001"]).isEmpty)
        }
    }

    // MARK: - Collapsing a pair that is NOT already on screen

    /// A task the board is not showing (a chip is narrowing to another band, say) still
    /// deserves a row — but ONE row, and the tappable one. `resultRow` only makes
    /// `type == "task"` hits open a task, so keeping the session copy would turn a real
    /// row into a dead one.
    func testASessionAndTaskPairCollapseToTheTappableTaskRow() {
        let kept = BoardSearchHitDedup.visibleHits(
            [sessionHit("t-2002"), taskHit("t-2002")], visibleTaskIds: []
        )
        XCTAssertEqual(kept.count, 1)
        XCTAssertEqual(kept.first?.type, "task", "the surviving row must be the one that opens the task")
        XCTAssertEqual(kept.first?.resultId, "t-2002")
    }

    /// The survivor keeps the SLOT the first of the pair won, so the server's ranking
    /// is untouched — a collapsed pair must not jump to the end of the list.
    func testTheSurvivorKeepsTheRankOfTheFirstOfThePair() {
        let hits = [
            taskHit("t-first", title: "first"),
            sessionHit("t-pair", title: "pair as session"),
            memoryHit("a note"),
            taskHit("t-pair", title: "pair as task"),
            taskHit("t-last", title: "last"),
        ]
        let kept = BoardSearchHitDedup.visibleHits(hits, visibleTaskIds: [])
        XCTAssertEqual(kept.map(\.title), ["first", "pair as task", "a note", "last"])
    }

    func testTwoTaskHitsForOneTaskCollapse() {
        let kept = BoardSearchHitDedup.visibleHits(
            [taskHit("t-3003", title: "kept"), taskHit("t-3003", title: "dropped")],
            visibleTaskIds: []
        )
        XCTAssertEqual(kept.map(\.title), ["kept"], "a duplicate task hit must not draw a second row")
    }

    // MARK: - What must NOT be deduped

    func testUnrelatedTasksAllKeepTheirRows() {
        let hits = [taskHit("t-1"), taskHit("t-2"), sessionHit("t-3")]
        XCTAssertEqual(BoardSearchHitDedup.visibleHits(hits, visibleTaskIds: ["t-9"]).count, 3)
    }

    /// Memory hits are not about a task, so nothing about them can pair or collapse —
    /// including two hits from the same note file.
    func testMemoryHitsArePassedThroughUntouched() {
        let hits = [memoryHit("one"), memoryHit("two"), taskHit("t-1")]
        let kept = BoardSearchHitDedup.visibleHits(hits, visibleTaskIds: ["t-1"])
        XCTAssertEqual(kept.map(\.title), ["one", "two"])
        XCTAssertEqual(types(kept), ["memory", "memory"])
    }

    /// A session with no owning task carries its own session id in `resultId`. It is
    /// still a row worth showing, and it can never pair with a task.
    func testASessionWithNoOwningTaskIsKept() {
        let orphan = sessionHit("f47ac10b-58cc-4372-a567-0e02b2c3d479")
        let kept = BoardSearchHitDedup.visibleHits([orphan, taskHit("t-1")], visibleTaskIds: [])
        XCTAssertEqual(kept.count, 2)
        XCTAssertEqual(types(kept), ["session", "task"])
    }

    /// A hit with no id at all cannot be identified, so it cannot be deduped either —
    /// and two of them must not collapse into each other.
    func testHitsWithNoIdAreNeverCollapsedTogether() {
        let kept = BoardSearchHitDedup.visibleHits(
            [taskHit(nil, title: "one"), taskHit(nil, title: "two")], visibleTaskIds: ["t-1"]
        )
        XCTAssertEqual(kept.map(\.title), ["one", "two"])
    }

    func testAnEmptyResponseStaysEmpty() {
        XCTAssertTrue(BoardSearchHitDedup.visibleHits([], visibleTaskIds: ["t-1"]).isEmpty)
    }

    // MARK: - Prefix matching, and its floor

    /// `TasksView` already resolves a hit against the store with `hasPrefix`, because a
    /// caller can answer a short id while the board holds the full one. Dedup has to
    /// agree with that, in both directions.
    func testAShortServerIdMatchesTheFullBoardId() {
        let full = "t-abc123def456"
        XCTAssertTrue(BoardSearchHitDedup.visibleHits([taskHit("t-abc123")], visibleTaskIds: [full]).isEmpty)
        XCTAssertTrue(BoardSearchHitDedup.visibleHits([taskHit(full)], visibleTaskIds: ["t-abc123"]).isEmpty)
    }

    /// The floor under that convenience, and the reason it exists: unbounded prefix
    /// matching is how a confident wrong answer gets made. A 5-character id must not
    /// swallow an unrelated task.
    func testAPrefixShorterThanTheFloorIsNotAMatch() {
        XCTAssertLessThan("t-abc".count, BoardSearchHitDedup.minimumIdOverlap)
        let kept = BoardSearchHitDedup.visibleHits([taskHit("t-abcdef123")], visibleTaskIds: ["t-abc"])
        XCTAssertEqual(kept.count, 1, "a 5-char id must not stand in for a whole task id")
        XCTAssertTrue(BoardSearchHitDedup.sameTask("t-abc", "t-abc"), "exact ids always match")
    }

    /// An id shorter than the floor is not excluded from dedup — it just has to match
    /// EXACTLY. (Implementation note this pins: the lookup buckets visible ids by their
    /// first `minimumIdOverlap` characters, so a sub-floor id has no bucket to live in
    /// and can only be found through the exact set.)
    func testAnIdShorterThanTheFloorStillMatchesExactly() {
        XCTAssertTrue(BoardSearchHitDedup.visibleHits([taskHit("t-1")], visibleTaskIds: ["t-1"]).isEmpty)
    }

    /// Several visible ids can share the same 6-character head, so the right one has to
    /// be picked out of that bucket rather than the first one in it.
    func testTheRightIdIsFoundAmongIdsSharingAPrefix() {
        let visible: Set<String> = ["t-abc123zzz", "t-abc123def456", "t-abc123qqq"]
        XCTAssertTrue(
            BoardSearchHitDedup.visibleHits([taskHit("t-abc123def")], visibleTaskIds: visible).isEmpty,
            "the hit prefixes t-abc123def456 and must be recognised past the shared head"
        )
        XCTAssertEqual(
            BoardSearchHitDedup.visibleHits([taskHit("t-abc123www")], visibleTaskIds: visible).count, 1,
            "a same-head id that prefixes nothing visible keeps its row"
        )
    }

    func testWhitespaceAroundAnIdDoesNotDefeatTheMatch() {
        XCTAssertTrue(
            BoardSearchHitDedup.visibleHits([taskHit(" t-1001 ")], visibleTaskIds: ["t-1001"]).isEmpty
        )
        XCTAssertTrue(
            BoardSearchHitDedup.visibleHits([taskHit("t-1001")], visibleTaskIds: [" t-1001 "]).isEmpty
        )
    }

    // MARK: - Invariants the view leans on

    /// `ForEach(hits)` keys on `GlobalSearchResult.id` (`"type|resultId"`), which is the
    /// mechanism that let the pair render twice. After dedup no two rows may share it.
    func testEveryRowHasAUniqueForEachIdentity() {
        let hits = [
            sessionHit("t-1"), taskHit("t-1"), taskHit("t-2"), sessionHit("t-2"),
            memoryHit("one"), memoryHit("two"), taskHit("t-3"),
        ]
        let kept = BoardSearchHitDedup.visibleHits(hits, visibleTaskIds: [])
        XCTAssertEqual(Set(kept.map(\.id)).count, kept.count, "two rows share a ForEach identity")
        XCTAssertEqual(kept.count, 5, "3 tasks + 2 memory notes")
    }

    /// Idempotent: re-running over its own output changes nothing. Cheap to assert and
    /// it rules out a rule that keeps eating rows on a second pass (the section runs
    /// this on every body pass).
    func testDedupIsIdempotent() {
        let hits = [sessionHit("t-1"), taskHit("t-1"), taskHit("t-2"), memoryHit("note")]
        let once = BoardSearchHitDedup.visibleHits(hits, visibleTaskIds: ["t-9"])
        let twice = BoardSearchHitDedup.visibleHits(once, visibleTaskIds: ["t-9"])
        XCTAssertEqual(once, twice)
    }

    /// The set the view passes in is "everything already on screen above", which on the
    /// board is its visible rows PLUS the local hit rows. Both must silence a server
    /// copy — a duplicate is a duplicate whichever list above it came from.
    func testBothTheBoardRowsAndTheLocalHitRowsSilenceAServerCopy() {
        let hits = [taskHit("t-board"), taskHit("t-local"), taskHit("t-elsewhere")]
        let kept = BoardSearchHitDedup.visibleHits(
            hits, visibleTaskIds: ["t-board", "t-local"]
        )
        XCTAssertEqual(kept.map(\.resultId), ["t-elsewhere"])
    }

    // MARK: - The R25 duplicate: a visible row keyed by a session UUID

    private func task(_ id: String) -> WalnutTask {
        WalnutTask(
            id: id, title: "Wire the board chips", status: "todo", phase: "TODO",
            priority: "none", project: "", dueDate: nil,
            createdAt: "2026-08-29T00:00:00Z", updatedAt: "2026-08-29T00:00:00Z",
            completedAt: nil, starred: nil, pinned: true, tags: nil, summary: nil,
            startDate: nil
        )
    }

    private func session(_ id: String, taskId: String?) -> WalnutSession {
        WalnutSession(
            id: id, title: "Session: walnut — chips", taskId: taskId, taskTitle: "t",
            project: nil, host: "", processStatus: "running", model: nil, mode: nil,
            startedAt: "2026-08-29T00:00:00Z", lastActiveAt: "2026-08-29T01:00:00Z",
            messageCount: 3, cwd: nil, pinned: true, focusTier: nil, description: nil
        )
    }

    /// THE measured duplicate. A board row whose owning task is missing from the phone's
    /// projection used to be keyed by the CLI session UUID (`board.row.a1d81a24-…`), so
    /// the visible-id set the dedup was handed never contained the id the server answers
    /// a task hit with (`mro772x3-1599`) — and the same task drew twice, 55pt apart.
    ///
    /// Two things had to change and both are exercised here: the row is keyed by the
    /// owning task id now (`BoardRow.owningTaskId`), and the set the dedup reads
    /// (`BoardModel.searchDedupIds`) carries every id such a row answers to, so the drop
    /// no longer depends on which one that is.
    func testAVisibleRowKeyedByASessionUUIDStillSilencesItsTasksServerHit() {
        let uuid = "a1d81a24-58cc-4372-a567-0e02b2c3d479"
        let ownedTaskId = "mro772x3-1599"
        let bands = BoardModel.bands(
            tasks: [task("p")],
            sessions: [session(uuid, taskId: ownedTaskId)],
            tierOf: ["p": "focus"], tierOrder: ["focus": ["p"]], customTiers: []
        )
        let visible = BoardModel.searchDedupIds(bands)

        // The board really is showing that work (as a session-only row in the tail).
        XCTAssertTrue(visible.contains(ownedTaskId))
        XCTAssertTrue(visible.contains(uuid), "the session id is an id that row answers to")

        XCTAssertTrue(
            BoardSearchHitDedup.visibleHits(
                [taskHit(ownedTaskId), sessionHit(ownedTaskId)], visibleTaskIds: visible
            ).isEmpty,
            "the task is already on screen — this is the row that drew twice"
        )
        // A session hit answered with the SESSION's own id is the same duplicate wearing
        // the other id, and it is dropped too.
        XCTAssertTrue(
            BoardSearchHitDedup.visibleHits([sessionHit(uuid)], visibleTaskIds: visible).isEmpty
        )

        // The narrow set is what the defect looked like: keyed by the UUID alone, the
        // task hit survives and the user sees the row twice.
        XCTAssertEqual(
            BoardSearchHitDedup.visibleHits(
                [taskHit(ownedTaskId)], visibleTaskIds: [uuid]
            ).count, 1,
            "if this drops, the fixture no longer reproduces the reported duplicate"
        )
    }

    // MARK: - A row must not say its title twice

    /// The server's real shape for a title match: `extractSnippet(task.title, query)`
    /// WINDOWS the title around the hit and wraps the cut ends in `...`, so the client is
    /// handed an ellipsised COPY of the line it is already drawing. The row then said its
    /// name twice, in two type sizes, and the second line read as a detail the user was
    /// missing (measured R25).
    ///
    /// The R25 rule deleted the title's characters out of the snippet and asked whether
    /// any alphanumerics survived, which could not see this: a window that starts
    /// mid-title does not CONTAIN the title, so the subtraction found nothing to remove,
    /// the whole snippet counted as residue, and the duplicate line shipped. The rule is
    /// a subset test now.
    func testAWindowedCopyOfTheTitleIsSuppressed() {
        let title = "Watch NVDA Q2 earnings call and write up the delta vs guidance"
        // Both cut ends — the case the residue rule kept.
        XCTAssertNil(GlobalSearchSection.snippetWorthShowing(
            title: title, snippet: "...Q2 earnings call and write up the delta..."),
            "a window cut out of the middle of the title is still the title")
        // Cut at the tail only (the hit was near the start).
        XCTAssertNil(GlobalSearchSection.snippetWorthShowing(
            title: title, snippet: "Watch NVDA Q2 earnings call and write up the..."))
        // The single-character ellipsis other lanes use.
        XCTAssertNil(GlobalSearchSection.snippetWorthShowing(
            title: title, snippet: "…Q2 earnings call and write up…"))
        // And the plain repeats.
        XCTAssertNil(GlobalSearchSection.snippetWorthShowing(title: title, snippet: title))
        XCTAssertNil(GlobalSearchSection.snippetWorthShowing(
            title: title, snippet: "  \(title)  "), "trimming is not a difference")
        XCTAssertNil(GlobalSearchSection.snippetWorthShowing(
            title: title, snippet: "watch NVDA q2 EARNINGS call and write up the delta vs guidance"),
            "case is not a difference")
        XCTAssertNil(GlobalSearchSection.snippetWorthShowing(
            title: title, snippet: "\"\(title).\""), "quotes around the title are not content")
        // A window whose whitespace the server collapsed (`\n` → ' ') is the same text.
        XCTAssertNil(GlobalSearchSection.snippetWorthShowing(
            title: "Watch NVDA Q2\n earnings call", snippet: "...Watch NVDA Q2 earnings call..."))
    }

    /// The other real shape, and the one the rule must NOT swing round and eat: a memory
    /// hit whose snippet is the note's own heading plus its tags. Those tags are the
    /// content — they are why the second line exists at all — and a rule that suppressed
    /// anything starting with the title would delete them.
    func testASnippetWithContentBeyondTheTitleKeepsItsLine() {
        let title = "Quarterly review"
        XCTAssertEqual(
            GlobalSearchSection.snippetWorthShowing(
                title: title, snippet: "Quarterly review #finance #q2 ..."),
            "Quarterly review #finance #q2 ...",
            "the tags are the only thing this row has to say"
        )
        XCTAssertEqual(
            GlobalSearchSection.snippetWorthShowing(
                title: title, snippet: "...Quarterly review — moved to March, see the thread..."),
            "...Quarterly review — moved to March, see the thread..."
        )
        // A passage that has nothing to do with the title (the ordinary memory hit).
        XCTAssertEqual(
            GlobalSearchSection.snippetWorthShowing(
                title: "a note", snippet: "the chip rail is clipped to its own column"),
            "the chip rail is clipped to its own column"
        )
        // Same words, different text: a snippet is only "the title again" if it really is
        // a window of it.
        XCTAssertEqual(
            GlobalSearchSection.snippetWorthShowing(
                title: title, snippet: "review of the quarter"),
            "review of the quarter"
        )
    }

    /// The OTHER direction, which the subset test alone could not see (R27): a snippet that
    /// contains the WHOLE title plus an overrun the edge-trimming never reaches, because the
    /// overrun is not a character it looks at. `…title — …` trims to `title —`, which the
    /// title does not contain, so the row printed its own name twice with a dangling mark
    /// under it. The rule now strips the title out and judges the REMAINDER.
    func testATitlePlusNothingButPunctuationIsStillTheTitleTwice() {
        let title = "Watch NVDA Q2 earnings call"
        for snippet in [
            "...Watch NVDA Q2 earnings call — ...",   // an em dash, which no edge set lists
            "Watch NVDA Q2 earnings call!",
            "Watch NVDA Q2 earnings call?!",
            "…Watch NVDA Q2 earnings call | …",
            "\"Watch NVDA Q2 earnings call\" - ...",
        ] {
            XCTAssertNil(
                GlobalSearchSection.snippetWorthShowing(title: title, snippet: snippet),
                "\(snippet) adds punctuation to the title, not information"
            )
        }
        // The remainder rule, on its own, with both sides already normalised.
        XCTAssertEqual(
            GlobalSearchSection.remainderBeyondTitle(
                title: "quarterly review", snippet: "quarterly review — "),
            " — "
        )
        XCTAssertNil(
            GlobalSearchSection.remainderBeyondTitle(
                title: "quarterly review", snippet: "review of the quarter"),
            "the title is not in there at all, so there is no remainder to judge"
        )
        XCTAssertFalse(GlobalSearchSection.carriesRealContent(" — …!? \"' "))
        XCTAssertTrue(GlobalSearchSection.carriesRealContent(" #q2 "), "a tag is content")
        XCTAssertTrue(GlobalSearchSection.carriesRealContent(" 2026 "), "so is a number")
    }

    /// And the rule must not swing round and eat the two shapes that DO carry something:
    /// the title inside a real sentence, and the memory hit's `title #tag #tag` line where
    /// the tags are the entire reason the second line exists.
    func testATitleInsideRealContentKeepsItsLine() {
        let title = "Quarterly review"
        XCTAssertEqual(
            GlobalSearchSection.snippetWorthShowing(
                title: title, snippet: "...See Quarterly review before Friday..."),
            "...See Quarterly review before Friday...",
            "the title embedded in a sentence is a sentence, not a repeat"
        )
        XCTAssertEqual(
            GlobalSearchSection.snippetWorthShowing(
                title: title, snippet: "Quarterly review #finance #q2 ..."),
            "Quarterly review #finance #q2 ...",
            "the tags are the only thing this row has to say"
        )
        // One word of overrun is still content: the rule is "does the remainder SAY
        // anything", not "is the remainder long".
        XCTAssertEqual(
            GlobalSearchSection.snippetWorthShowing(
                title: title, snippet: "Quarterly review cancelled"),
            "Quarterly review cancelled"
        )
    }

    /// The normalisation both sides go through, on its own: it strips DECORATION and
    /// nothing else. It is what makes the subset test honest rather than a lucky match.
    func testTheNormalisationStripsDecorationAndKeepsContent() {
        XCTAssertEqual(GlobalSearchSection.normalizedSnippetText("...Q2 earnings..."),
                       "q2 earnings")
        XCTAssertEqual(GlobalSearchSection.normalizedSnippetText("…\"Q2 earnings\".…"),
                       "q2 earnings", "quotes outside an ellipsis, and a full stop inside")
        XCTAssertEqual(GlobalSearchSection.normalizedSnippetText("  Q2\n\n  earnings  "),
                       "q2 earnings", "whitespace runs collapse")
        XCTAssertEqual(GlobalSearchSection.normalizedSnippetText("#finance #q2"),
                       "#finance #q2", "a tag is content, not decoration")
        XCTAssertEqual(GlobalSearchSection.normalizedSnippetText("Ship v2.0 today"),
                       "ship v2.0 today", "an inner full stop is part of the word")
        XCTAssertEqual(GlobalSearchSection.normalizedSnippetText("…"), "")
        XCTAssertEqual(GlobalSearchSection.normalizedSnippetText("..."), "")
        XCTAssertEqual(GlobalSearchSection.normalizedSnippetText("   "), "")
    }

    func testAnEmptyOrAbsentSnippetDrawsNoLine() {
        XCTAssertNil(GlobalSearchSection.snippetWorthShowing(title: "t", snippet: nil))
        XCTAssertNil(GlobalSearchSection.snippetWorthShowing(title: "t", snippet: ""))
        XCTAssertNil(GlobalSearchSection.snippetWorthShowing(title: "t", snippet: "   "))
        XCTAssertNil(GlobalSearchSection.snippetWorthShowing(title: "t", snippet: "…"))
    }

    /// A hit with no title at all must not lose its snippet: that is the only text it has.
    func testATitlelessHitKeepsItsSnippet() {
        XCTAssertEqual(
            GlobalSearchSection.snippetWorthShowing(title: "", snippet: "the only text there is"),
            "the only text there is"
        )
    }
}
