import XCTest
@testable import Walnut

/// Folding the board: which groups exist, what a folded group draws, and the one button
/// that folds them all (one key collapses the board).
final class BoardCollapseTests: XCTestCase {

    private func row(_ id: String) -> BoardRow {
        BoardRow(task: SessionTaskRow.placeholder(id: id, title: id), session: nil)
    }

    private func band(_ id: String, rows: Int, nest: BoardBandNest? = nil) -> BoardBand {
        var band = BoardBand(
            bandId: id, label: id, rows: (0..<rows).map { row("\(id)-\($0)") },
            hiddenDone: 0, createSeed: nil
        )
        band.nest = nest
        return band
    }

    private func folder(_ id: String, in project: String, rows: Int, leads: Bool = false) -> BoardBand {
        band(
            "folder:\(id)", rows: rows,
            nest: BoardBandNest(
                folderId: id, projectBandId: project, projectLabel: project, leadsProject: leads
            )
        )
    }

    /// Tier grouping: every band is its own group.
    private var tierBands: [BoardBand] {
        [band("focus", rows: 3), band("satellite", rows: 2), band("backlog", rows: 4)]
    }

    /// Project grouping: marina has loose rows and two folders; pebble's rows are all in a
    /// folder, so that folder leads the project.
    private var projectBands: [BoardBand] {
        [
            band("proj:marina", rows: 1),
            folder("m1", in: "proj:marina", rows: 2),
            folder("m2", in: "proj:marina", rows: 3),
            folder("p1", in: "proj:pebble", rows: 4, leads: true),
        ]
    }

    // MARK: - Groups

    func testATierBandIsItsOwnGroup() {
        XCTAssertEqual(BoardCollapse.groupKeys(tierBands), ["focus", "satellite", "backlog"])
    }

    func testAFolderBelongsToItsProjectsGroup() {
        XCTAssertEqual(BoardCollapse.groupKeys(projectBands), ["proj:marina", "proj:pebble"])
    }

    // MARK: - What is drawn

    func testNothingFoldedDrawsEveryBandWithItsOwnCount() {
        let entries = BoardCollapse.entries(projectBands, collapsed: [])
        XCTAssertEqual(entries.map(\.id), projectBands.map(\.bandId))
        XCTAssertTrue(entries.allSatisfy { !$0.collapsed })
        XCTAssertEqual(entries.map(\.groupCount), [1, 2, 3, 4])
    }

    /// A folded project is ONE heading carrying the whole project's count; its folders are
    /// not drawn at all, so "collapse" really leaves one line per project.
    func testAFoldedProjectIsOneHeadingWithTheWholeProjectsCount() {
        let entries = BoardCollapse.entries(projectBands, collapsed: ["proj:marina"])
        XCTAssertEqual(entries.map(\.id), ["proj:marina", "folder:p1"])
        XCTAssertEqual(entries[0].collapsed, true)
        XCTAssertEqual(entries[0].groupCount, 6, "1 loose + 2 + 3 in its folders")
        XCTAssertEqual(entries[1].collapsed, false)
    }

    /// A project with no loose rows folds onto its leading folder band, which is the band
    /// that draws the project's heading.
    func testAProjectWithOnlyFoldersFoldsOntoItsLeadingFolder() {
        let entries = BoardCollapse.entries(projectBands, collapsed: ["proj:pebble"])
        let pebble = try? XCTUnwrap(entries.last)
        XCTAssertEqual(pebble?.id, "folder:p1")
        XCTAssertEqual(pebble?.collapsed, true)
        XCTAssertEqual(pebble?.groupCount, 4)
    }

    /// A fold the board does not have on screen (another tier's project, a stale key) is
    /// harmless: nothing matches it, nothing disappears.
    func testAnUnknownFoldKeyHidesNothing() {
        let entries = BoardCollapse.entries(tierBands, collapsed: ["proj:gone"])
        XCTAssertEqual(entries.map(\.id), ["focus", "satellite", "backlog"])
        XCTAssertTrue(entries.allSatisfy { !$0.collapsed })
    }

    // MARK: - The one button

    func testCollapseAllFoldsEveryGroupOnScreen() {
        let all = BoardCollapse.togglingAll(projectBands, collapsed: [])
        XCTAssertEqual(all, ["proj:marina", "proj:pebble"])
        XCTAssertTrue(BoardCollapse.allCollapsed(projectBands, collapsed: all))
        XCTAssertEqual(
            BoardCollapse.entries(projectBands, collapsed: all).map(\.id),
            ["proj:marina", "folder:p1"],
            "one heading per project"
        )
    }

    /// Some folded, some not: the button folds the rest rather than unfolding the folded.
    func testCollapseAllFromAMixedStateFoldsTheRest() {
        let next = BoardCollapse.togglingAll(tierBands, collapsed: ["satellite"])
        XCTAssertEqual(next, ["focus", "satellite", "backlog"])
    }

    func testExpandAllWhenEverythingIsFolded() {
        let folded: Set<String> = ["focus", "satellite", "backlog"]
        XCTAssertEqual(BoardCollapse.togglingAll(tierBands, collapsed: folded), [])
    }

    /// Folds the user made for groups that are not on screen right now (another tier's
    /// projects) survive the button, both ways.
    func testTheButtonLeavesOffScreenGroupsAlone() {
        let folded = BoardCollapse.togglingAll(tierBands, collapsed: ["proj:elsewhere"])
        XCTAssertTrue(folded.contains("proj:elsewhere"))
        let unfolded = BoardCollapse.togglingAll(tierBands, collapsed: folded)
        XCTAssertEqual(unfolded, ["proj:elsewhere"])
    }

    func testAnEmptyBoardIsNeverAllCollapsed() {
        XCTAssertFalse(BoardCollapse.allCollapsed([], collapsed: ["focus"]))
    }

    func testOneHeadingTogglesOnlyItsGroup() {
        let once = BoardCollapse.toggling("focus", in: ["backlog"])
        XCTAssertEqual(once, ["focus", "backlog"])
        XCTAssertEqual(BoardCollapse.toggling("focus", in: once), ["backlog"])
    }

    // MARK: - Persistence

    func testTheFoldsRoundTripThroughTheStoredString() {
        // A CJK project name survives the stored string.
        let keys: Set<String> = ["focus", "proj:\u{5DE5}\u{4F5C}", "proj:marina"]
        XCTAssertEqual(BoardCollapse.decode(BoardCollapse.encode(keys)), keys)
        XCTAssertEqual(BoardCollapse.encode([]), "", "nothing folded stores nothing")
    }

    func testGarbageInTheStoreFoldsNothing() {
        XCTAssertEqual(BoardCollapse.decode(""), [])
        XCTAssertEqual(BoardCollapse.decode("not json"), [])
        XCTAssertEqual(BoardCollapse.decode("{\"a\":1}"), [])
    }

    func testTheStorageKeySitsBesideTheBoardsOtherViewChoices() {
        XCTAssertEqual(BoardCollapse.storageKey, "tasks.board.collapsedGroups")
        XCTAssertTrue(BoardFilterPrefs.showDoneKey.hasPrefix("tasks.board."))
    }

    // MARK: - A row just made

    func testANewRowOpensTheGroupItLandsInAndNoOther() {
        let folded: Set<String> = ["proj:marina", "proj:pebble"]
        XCTAssertEqual(
            BoardCollapse.unfolding(taskId: "folder:m2-1", in: projectBands, collapsed: folded),
            ["proj:pebble"], "a row in a folder opens its project"
        )
        XCTAssertEqual(
            BoardCollapse.unfolding(taskId: "satellite-0", in: tierBands, collapsed: ["focus", "satellite"]),
            ["focus"]
        )
    }

    func testARowNotOnTheBoardChangesNoFold() {
        let folded: Set<String> = ["focus"]
        XCTAssertEqual(BoardCollapse.unfolding(taskId: "elsewhere", in: tierBands, collapsed: folded), folded)
        XCTAssertFalse(BoardCollapse.contains(taskId: "elsewhere", in: tierBands))
        XCTAssertTrue(BoardCollapse.contains(taskId: "backlog-3", in: tierBands))
    }
}

/// A task opened from anywhere on the Tasks tab (a search hit, a calendar item) routes
/// through the same rule a board row does, so it needs a row of its own.
final class BoardRowForTaskTests: XCTestCase {

    private func session(_ id: String, taskId: String?, lastActive: String) -> WalnutSession {
        WalnutSession(
            id: id, title: id, taskId: taskId, taskTitle: nil, project: nil, host: "",
            processStatus: "idle", model: nil, mode: nil, startedAt: lastActive,
            lastActiveAt: lastActive, messageCount: 1, cwd: nil, pinned: nil,
            focusTier: nil, description: nil
        )
    }

    func testTheRowCarriesTheTasksNewestSession() {
        let task = SessionTaskRow.placeholder(id: "t1", title: "Fix it")
        let row = BoardModel.row(for: task, sessions: [
            session("old", taskId: "t1", lastActive: "2026-10-01T00:00:00Z"),
            session("other", taskId: "t2", lastActive: "2026-10-09T00:00:00Z"),
            session("new", taskId: "t1", lastActive: "2026-10-08T00:00:00Z"),
        ], knownSessionIds: nil)
        XCTAssertEqual(row.id, "t1")
        XCTAssertEqual(row.session?.id, "new")
        guard case .open(let opened) = BoardModel.tapRoute(row) else {
            return XCTFail("a task with a listed session opens it")
        }
        XCTAssertEqual(opened.id, "new")
    }

    /// No session in the list and nothing known: ask the server before drafting, never a
    /// draft on top of a session that aged out of the list.
    func testATaskTheListHasNoSessionForIsProbedNotDrafted() {
        let task = SessionTaskRow.placeholder(id: "t9", title: "Old work")
        let row = BoardModel.row(for: task, sessions: [], knownSessionIds: nil)
        guard case .probe(let taskId, _) = BoardModel.tapRoute(row) else {
            return XCTFail("an unknown task must be probed, got \(BoardModel.tapRoute(row))")
        }
        XCTAssertEqual(taskId, "t9")
    }

    /// Known to have no sessions: straight to the draft, attached to the task.
    func testATaskKnownToHaveNoSessionOpensAnAttachedDraft() {
        let task = SessionTaskRow.placeholder(id: "t3", title: "New idea")
        let row = BoardModel.row(for: task, sessions: [], knownSessionIds: [])
        guard case .draft(let seed) = BoardModel.tapRoute(row) else {
            return XCTFail("expected a draft, got \(BoardModel.tapRoute(row))")
        }
        XCTAssertEqual(seed.taskId, "t3")
    }
}
