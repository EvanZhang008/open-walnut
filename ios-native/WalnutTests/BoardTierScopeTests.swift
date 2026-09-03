import XCTest
@testable import Walnut

/// The board's TWO decisions, separated: **which tier am I looking at** (the chip rail)
/// and **how are those rows headed** (the grouping chip).
///
/// The defect these pin: the rail used to be whatever the bands happened to be, so
/// switching to `By project` re-populated it with `proj:` / `folder:` chips, cleared the
/// tier selection, and grouped EVERY pinned row instead of the selected tier's. In the
/// user's words: the rail should not list all the folders above, the grouping belongs to
/// the list below, and the old shape "isn't intuitive and takes multiple taps".
///
/// So: the rail is ALWAYS the tier rail, the tier narrows the row set at CONSTRUCTION
/// time (before the grouping branch, so a project heading's count and its rows are both
/// the tier's subset), and switching grouping keeps the tier.
///
/// Everything below goes through `board(scope:grouping:)` / `rail(grouping:)`, which are
/// the whole board pipeline for one pass. Stated once, at the top, so every case reads as
/// "what the screen shows" rather than as a call into a particular helper.
final class BoardTierScopeTests: XCTestCase {

    private static let now = WalnutTask.parseISO("2026-08-27T12:00:00Z")!

    private func task(
        _ id: String, project: String = "", status: String = "todo",
        phase: String = "TODO", pinned: Bool? = true, start: String? = nil
    ) -> WalnutTask {
        WalnutTask(
            id: id, title: "task \(id)", status: status, phase: phase,
            priority: "none", project: project, dueDate: nil,
            createdAt: "2026-08-27T00:00:00Z", updatedAt: "2026-08-27T00:00:00Z",
            completedAt: status == "done" ? "2026-08-27T01:00:00Z" : nil,
            starred: nil, pinned: pinned, tags: nil, summary: nil, startDate: start
        )
    }

    // MARK: - The fixture: a DIFFERENT project spread per tier
    //
    // That difference is the whole point. If every tier held the same projects, a board
    // that grouped the WHOLE pinned set would look identical to one that grouped the
    // selected tier's, and the core bug would be invisible.
    //
    //   focus     → marina (f1, f3), acme (f2)
    //   satellite → zephyr (s1), Inbox (s2)
    //   backlog   → marina (b1)

    private var fixtureTasks: [WalnutTask] {
        [
            task("f1", project: "marina"),
            task("f2", project: "acme"),
            task("f3", project: "marina"),
            task("s1", project: "zephyr"),
            task("s2", project: ""),
            task("b1", project: "marina"),
            // Three rows that are not on the board at all, so "the tier's subset" can
            // never be satisfied by a fixture where everything is pinned.
            task("loose", project: "marina", pinned: false),
            task("loose2", project: "zephyr", pinned: false),
            task("loose3", project: "acme", pinned: false),
        ]
    }

    private var fixtureTierOf: [String: String] {
        ["f1": "focus", "f2": "focus", "f3": "focus",
         "s1": "satellite", "s2": "satellite", "b1": "backlog"]
    }

    private var fixtureTierOrder: [String: [String]] {
        ["focus": ["f1", "f2", "f3"], "satellite": ["s1", "s2"], "backlog": ["b1"]]
    }

    private static let focusIds: Set<String> = ["f1", "f2", "f3"]

    // MARK: - The pipeline under test

    private func assembled(
        _ tasks: [WalnutTask], tierOf: [String: String], tierOrder: [String: [String]],
        scope: String?, grouping: BoardGrouping,
        dateFilter: BoardDateFilter = .all, shownDone: Set<String> = [],
        folders: BoardFolderIndex = .empty, customTiers: [FocusTierInfo] = []
    ) -> BoardAssembly {
        BoardModel.assemble(
            tasks: tasks, sessions: [], tierOf: tierOf, tierOrder: tierOrder,
            customTiers: customTiers, query: "", grouping: grouping,
            dateFilter: dateFilter, shownDoneTiers: shownDone, folders: folders,
            scope: scope, now: Self.now
        )
    }

    /// The bands the screen renders for one (scope, grouping) pair.
    private func board(
        scope: String?, grouping: BoardGrouping,
        dateFilter: BoardDateFilter = .all, shownDone: Set<String> = [],
        tasks: [WalnutTask]? = nil, tierOf: [String: String]? = nil,
        tierOrder: [String: [String]]? = nil, folders: BoardFolderIndex = .empty
    ) -> [BoardBand] {
        assembled(
            tasks ?? fixtureTasks, tierOf: tierOf ?? fixtureTierOf,
            tierOrder: tierOrder ?? fixtureTierOrder, scope: scope, grouping: grouping,
            dateFilter: dateFilter, shownDone: shownDone, folders: folders
        ).bands
    }

    /// The chip rail the screen draws above those bands.
    private func rail(
        grouping: BoardGrouping, scope: String? = nil,
        dateFilter: BoardDateFilter = .all, shownDone: Set<String> = [],
        tasks: [WalnutTask]? = nil, tierOf: [String: String]? = nil,
        tierOrder: [String: [String]]? = nil, customTiers: [FocusTierInfo] = []
    ) -> [BoardModel.BandChip] {
        assembled(
            tasks ?? fixtureTasks, tierOf: tierOf ?? fixtureTierOf,
            tierOrder: tierOrder ?? fixtureTierOrder, scope: scope, grouping: grouping,
            dateFilter: dateFilter, shownDone: shownDone, customTiers: customTiers
        ).rail
    }

    /// The tier scope the board actually honoured — nil = the whole board.
    private func honouredScope(_ scope: String?, grouping: BoardGrouping) -> String? {
        assembled(
            fixtureTasks, tierOf: fixtureTierOf, tierOrder: fixtureTierOrder,
            scope: scope, grouping: grouping
        ).scope
    }

    /// Where the board's top-level quick add files a task.
    private func quickAddSeed(scope: String?, grouping: BoardGrouping) -> NewTaskSeed {
        TasksView.boardQuickAddSeed(scope: honouredScope(scope, grouping: grouping))
    }

    /// What a stored preference reads back as, for one scope.
    private func storedGrouping(
        for scope: String?, modes: String, legacy: String
    ) -> BoardGrouping {
        BoardFilterPrefs.grouping(scope: scope, modes: modes, legacy: legacy)
    }

    /// What writing one scope's grouping leaves in defaults.
    private func storingGrouping(
        _ grouping: BoardGrouping, for scope: String?, modes: String
    ) -> String {
        BoardFilterPrefs.withGrouping(grouping, scope: scope, modes: modes)
    }

    // MARK: - Helpers over the rendered board

    private func rowIds(_ bands: [BoardBand]) -> Set<String> {
        Set(bands.flatMap { $0.rows.map(\.id) })
    }

    /// Every heading that NAMES A PROJECT: a project band whose word is its project's own
    /// name, plus the stand-in heading a folder band draws when it leads its project.
    ///
    /// Judged by the WORD and not by the band id, deliberately. A project band whose single
    /// redundant name was suppressed keeps its `proj:<name>` id (the hide-done key, the
    /// scroll anchor and the accessibility id all live on it) and reads the tier instead —
    /// so counting by id would report a project heading that is nowhere on the screen.
    private func projectHeadings(_ bands: [BoardBand]) -> [String] {
        var out: [String] = []
        for band in bands {
            if let nest = band.nest {
                if nest.leadsProject { out.append(nest.projectLabel) }
                continue
            }
            guard band.bandId.hasPrefix(BoardModel.projectBandPrefix) else { continue }
            let name = String(band.bandId.dropFirst(BoardModel.projectBandPrefix.count))
            let projectLabel = name.isEmpty ? NewTaskSeed.inboxHeader : name
            if band.label == projectLabel { out.append(band.label) }
        }
        return out
    }

    // MARK: - B: the core bug — By project inside a tier shows ONLY that tier

    /// **THE bug.** Scope to Focus, group `By project`, and both halves of every project
    /// band have to be the Focus subset: the rows AND the count on the heading.
    ///
    /// Stated as three separate assertions on purpose, because the shipped defect passed
    /// two of the three shapes you might reach for first: the row COUNT alone is
    /// satisfied by any narrowing, and the band LIST alone is satisfied by a board that
    /// post-filters assembled project bands (the heading then keeps a board-wide count
    /// over a narrowed row list — a heading that disagrees with the rows under it).
    func testByProjectInsideATierShowsOnlyThatTiersProjectsAndCounts() {
        let bands = board(scope: "focus", grouping: .project)

        // 1. The rows are Focus's, and nothing else's.
        XCTAssertEqual(
            rowIds(bands), Self.focusIds,
            "By project inside Focus drew rows from other tiers: \(rowIds(bands).subtracting(Self.focusIds).sorted())"
        )

        // 2. The HEADINGS are the projects present in Focus, and only those. `zephyr`
        //    and Inbox belong to Satellite and must not head a band here.
        XCTAssertEqual(
            bands.map(\.bandId), ["proj:acme", "proj:marina"],
            "the project bands are Focus's own — Inbox/zephyr came from Satellite"
        )

        // 3. Each heading's COUNT is that project's contribution to THIS tier, not a
        //    board-wide project total: marina holds f1+f3 here and b1 in Backlog, so a
        //    board-wide count would read 3.
        XCTAssertEqual(bands.first { $0.bandId == "proj:marina" }?.count, 2,
            "marina's heading must count its FOCUS rows (f1, f3) — b1 is Backlog's")
        XCTAssertEqual(bands.first { $0.bandId == "proj:acme" }?.count, 1)
        XCTAssertEqual(
            bands.reduce(0) { $0 + $1.count }, Self.focusIds.count,
            "the headings' counts have to add up to the tier's own rows"
        )
    }

    /// Every project AND folder in the selected tier is a heading in ONE scrollable
    /// list: no extra taps to reach a folder, and a folder holding only OTHER tiers'
    /// rows is not on screen at all.
    func testEveryProjectAndFolderInTheTierIsAHeadingInOneList() {
        let folders = BoardFolderIndex.build([
            // A folder whose members are Focus rows: it belongs on the scoped board.
            TaskFolder(groupId: "g_ship", label: "Ship", memberIds: ["f1"], project: "marina"),
            // A SUBFOLDER of it, also Focus: nested, one indent step further in.
            TaskFolder(
                groupId: "g_docs", label: "Docs", memberIds: ["f3"], project: "marina",
                parentId: "g_ship"
            ),
            // A folder holding only a BACKLOG row: nothing for the Focus board to draw.
            TaskFolder(groupId: "g_later", label: "Later", memberIds: ["b1"], project: "marina"),
        ])
        let bands = board(scope: "focus", grouping: .project, folders: folders)

        XCTAssertEqual(
            bands.map(\.bandId), ["proj:acme", "folder:g_ship", "folder:g_docs"],
            "the tier's folders nest in pre-order, and Backlog's folder is not here"
        )
        XCTAssertEqual(bands.first { $0.bandId == "folder:g_ship" }?.nest?.depth, 1)
        XCTAssertEqual(bands.first { $0.bandId == "folder:g_docs" }?.nest?.depth, 2,
            "a subfolder indents one step per level — the existing nesting machinery")
        XCTAssertEqual(rowIds(bands), Self.focusIds)
    }

    // MARK: - C: switching grouping PRESERVES the tier scope

    /// The grouping chip changes HEADINGS, never which tier you are in.
    ///
    /// The old code cleared the selection on every grouping switch, reasoning that
    /// `focus` and `proj:marina` are different id spaces. That reasoning dies with the
    /// rail: the rail only ever holds tier ids now.
    func testSwitchingGroupingKeepsTheTierScope() {
        for scope in ["focus", "satellite", "backlog"] {
            let expected = Set(fixtureTierOf.filter { $0.value == scope }.map { $0.key })
            for grouping in BoardGrouping.allCases {
                XCTAssertEqual(
                    rowIds(board(scope: scope, grouping: grouping)), expected,
                    "\(grouping.rawValue) inside \(scope) is not \(scope)'s own rows"
                )
                XCTAssertEqual(
                    honouredScope(scope, grouping: grouping), scope,
                    "\(grouping.rawValue) dropped the \(scope) scope"
                )
            }
        }
        // Said once more as the property itself: the POPULATION is grouping-independent
        // within a scope, which is the invariant the whole-board version of this case
        // (`testSwitchingGroupingNeverChangesThePopulation`) states one scope wider.
        for scope in [nil, "focus", "satellite", "backlog"] as [String?] {
            XCTAssertEqual(
                rowIds(board(scope: scope, grouping: .tier)),
                rowIds(board(scope: scope, grouping: .project)),
                "scope=\(scope ?? "All"): switching grouping changed WHICH rows exist"
            )
        }
    }

    /// The scope is remembered per LAUNCH, not per grouping switch: it lives in its own
    /// defaults key, so writing a grouping cannot clear it.
    func testTheScopeAndTheGroupingAreSeparateStores() {
        XCTAssertEqual(BoardFilterPrefs.tierScopeKey, "tasks.board.tierScope")
        XCTAssertNotEqual(BoardFilterPrefs.tierScopeKey, BoardFilterPrefs.groupingModesKey)
        XCTAssertNotEqual(BoardFilterPrefs.tierScopeKey, BoardFilterPrefs.groupingKey)

        XCTAssertNil(BoardFilterPrefs.scope(""), "no stored scope means the whole board")
        XCTAssertEqual(BoardFilterPrefs.scope("focus"), "focus")
        XCTAssertEqual(BoardFilterPrefs.scope("  focus  "), "focus")
        XCTAssertEqual(BoardFilterPrefs.scope("ct_abc12345"), "ct_abc12345")
        // A hand-edited plist (or an older build's band selection) can hold a BAND id.
        // The rail has no such chip, so honouring it would be an unreachable state.
        for banned in ["proj:marina", "proj:", "folder:g_docs", "a:b"] {
            XCTAssertNil(BoardFilterPrefs.scope(banned),
                "\(banned) is a band id, never a tier scope")
        }
    }

    // MARK: - D: the rail is ALWAYS the tier rail

    /// Under EVERY grouping, every date filter, every done fold and every scope, no chip
    /// in the rail carries a `proj:` or `folder:` id. That is the user's complaint stated
    /// as an invariant: the rail must not become a list of folders.
    func testNoChipInTheRailIsEverAProjectOrAFolder() {
        let folders = BoardFolderIndex.build([
            TaskFolder(groupId: "g_ship", label: "Ship", memberIds: ["f1"], project: "marina"),
            TaskFolder(groupId: "g_inb", label: "Notes", memberIds: ["s2"], project: ""),
        ])
        let custom = [FocusTierInfo(id: "ct_deep", label: "Deep Work")]
        var tierOf = fixtureTierOf
        tierOf["f2"] = "ct_deep"
        var tierOrder = fixtureTierOrder
        tierOrder["focus"] = ["f1", "f3"]
        tierOrder["ct_deep"] = ["f2"]

        for grouping in BoardGrouping.allCases {
            for dateFilter in BoardDateFilter.allCases {
                for shown in [Set<String>(), ["focus"], ["proj:marina"], ["folder:g_ship"]] {
                    for scope in [nil, "focus", "ct_deep", "backlog"] as [String?] {
                        let chips: [BoardModel.BandChip] = assembled(
                            fixtureTasks, tierOf: tierOf, tierOrder: tierOrder,
                            scope: scope, grouping: grouping, dateFilter: dateFilter,
                            shownDone: shown, folders: folders, customTiers: custom
                        ).rail
                        let state = "grouping=\(grouping.rawValue) date=\(dateFilter.rawValue) shown=\(shown.sorted()) scope=\(scope ?? "All")"
                        for chip in chips {
                            guard let bandId = chip.bandId else { continue }
                            XCTAssertFalse(
                                bandId.hasPrefix(BoardModel.projectBandPrefix)
                                    || bandId.hasPrefix(BoardModel.folderBandPrefix),
                                "\(state): the rail grew a non-tier chip: \(bandId)"
                            )
                        }
                        // …and it is the TIER rail, not merely "no projects": the ids it
                        // does carry are the board's tiers, in tier order.
                        XCTAssertEqual(
                            chips.compactMap(\.bandId),
                            ["focus", "satellite", "backlog", "ct_deep"],
                            "\(state): the rail is not the tier rail"
                        )
                        XCTAssertNil(chips.first?.bandId, "\(state): All still leads")
                    }
                }
            }
        }
    }

    // MARK: - A: the tier counts do not depend on the grouping

    /// For a fixed date filter, the rail's per-tier counts are IDENTICAL under both
    /// groupings — because the rail is not built from the rendered bands any more.
    ///
    /// It is worth pinning rather than obvious: the rail used to read its counts off
    /// whatever bands the grouping produced, so `By project` had no tier counts at all.
    func testTheTierCountsAreTheSameUnderBothGroupings() {
        for dateFilter in BoardDateFilter.allCases {
            for scope in [nil, "focus", "satellite"] as [String?] {
                let byTier = rail(grouping: .tier, scope: scope, dateFilter: dateFilter)
                let byProject = rail(grouping: .project, scope: scope, dateFilter: dateFilter)
                XCTAssertEqual(
                    byTier.map(\.id), byProject.map(\.id),
                    "date=\(dateFilter.rawValue) scope=\(scope ?? "All"): the rail changed shape with the grouping"
                )
                XCTAssertEqual(
                    byTier.map(\.count), byProject.map(\.count),
                    "date=\(dateFilter.rawValue) scope=\(scope ?? "All"): the tier counts moved with the grouping"
                )
                XCTAssertEqual(
                    byTier.map(\.label), byProject.map(\.label)
                )
            }
        }
        // And the numbers are the tiers' own, after the date filter.
        let chips = rail(grouping: .project)
        XCTAssertEqual(chips.first?.count, 6, "All counts the whole pinned board")
        XCTAssertEqual(chips.first { $0.bandId == "focus" }?.count, 3)
        XCTAssertEqual(chips.first { $0.bandId == "satellite" }?.count, 2)
        XCTAssertEqual(chips.first { $0.bandId == "backlog" }?.count, 1)
    }

    /// The `Now` filter is a PER-ROW predicate on the row's own start date, so it
    /// commutes with the tier scope: the rail's tier counts under `Now` are the same
    /// whether you read them scoped or unscoped, and a deferred row is gone from both
    /// groupings of its tier.
    func testTheDateFilterCommutesWithTheTierScope() {
        var tasks = fixtureTasks
        // f2 starts next month: `Now` hides it, `All` does not.
        tasks[1] = task("f2", project: "acme", start: "2026-09-20T00:00:00Z")

        for grouping in BoardGrouping.allCases {
            let now = assembled(
                tasks, tierOf: fixtureTierOf, tierOrder: fixtureTierOrder,
                scope: "focus", grouping: grouping, dateFilter: .now
            )
            XCTAssertEqual(rowIds(now.bands), ["f1", "f3"],
                "\(grouping.rawValue): the deferred row is hidden inside the tier too")
            XCTAssertEqual(now.rail.first { $0.bandId == "focus" }?.count, 2,
                "\(grouping.rawValue): the chip counts the tier AFTER the date filter")
            XCTAssertEqual(now.rail.first?.count, 5, "\(grouping.rawValue): All too")
        }
    }

    // MARK: - A redundant single project heading is not drawn

    /// A tier holding ONE distinct project gets no project heading: a heading naming
    /// something the whole visible list already is is noise. Two projects, two headings.
    ///
    /// The suppression is narrowed to the FLAT case (one project and no folder bands) on
    /// purpose: with folders on screen the project heading is the root the folder indents
    /// refer to, and dropping it would leave an indented folder heading under a name the
    /// screen never said — the exact defect `leadsProject` / `leadFolders` exist to
    /// prevent.
    func testATierWithOneProjectDrawsNoProjectHeading() {
        let tasks = [
            // Focus: two tasks, ONE project.
            task("f1", project: "marina"), task("f2", project: "marina"),
            // Satellite: two tasks, TWO projects.
            task("s1", project: "acme"), task("s2", project: "zephyr"),
        ]
        let tierOf = ["f1": "focus", "f2": "focus", "s1": "satellite", "s2": "satellite"]
        let tierOrder = ["focus": ["f1", "f2"], "satellite": ["s1", "s2"]]

        let focus = board(
            scope: "focus", grouping: .project,
            tasks: tasks, tierOf: tierOf, tierOrder: tierOrder
        )
        XCTAssertEqual(projectHeadings(focus), [],
            "one project across the whole list — the heading says nothing new")
        XCTAssertEqual(rowIds(focus), ["f1", "f2"], "and every row is still on screen")
        // The band survives with its controls: it is what carries `show done (N)` and the
        // create ring, so suppressing the NAME may not suppress the band.
        XCTAssertEqual(focus.count, 1)
        XCTAssertEqual(focus.first?.label, "Focus",
            "with no project worth naming the heading names the tier you are in")
        XCTAssertEqual(focus.first?.createSeed?.project, "marina",
            "a relabelled heading still files into the project its rows are in")

        let satellite = board(
            scope: "satellite", grouping: .project,
            tasks: tasks, tierOf: tierOf, tierOrder: tierOrder
        )
        XCTAssertEqual(projectHeadings(satellite), ["acme", "zephyr"],
            "two projects in the tier: both are named")

        // A FOLDER on screen keeps the project heading, whatever the project count.
        let folders = BoardFolderIndex.build([
            TaskFolder(groupId: "g_ship", label: "Ship", memberIds: ["f2"], project: "marina")
        ])
        let nested = board(
            scope: "focus", grouping: .project,
            tasks: tasks, tierOf: tierOf, tierOrder: tierOrder, folders: folders
        )
        XCTAssertEqual(projectHeadings(nested), ["marina"],
            "the folder indent needs the project heading it is indented under")
    }

    // MARK: - The grouping is remembered PER TIER

    /// Each tier remembers how it was last viewed, so switching tabs restores that tab's
    /// own mode instead of carrying one over. `All` has a key of its own.
    func testEachTierRemembersItsOwnGrouping() {
        let stored = storingGrouping(.project, for: "focus", modes: "")
        XCTAssertEqual(storedGrouping(for: "focus", modes: stored, legacy: ""), .project,
            "the tier the user switched keeps By project")
        XCTAssertEqual(
            storedGrouping(for: "satellite", modes: stored, legacy: ""),
            BoardFilterPrefs.defaultGrouping,
            "a tier nobody switched keeps its own default — the grouping is not one global value"
        )

        let both = storingGrouping(.project, for: nil, modes: stored)
        XCTAssertEqual(storedGrouping(for: nil, modes: both, legacy: ""), .project,
            "All is a scope with a stored mode of its own")
        XCTAssertEqual(storedGrouping(for: "focus", modes: both, legacy: ""), .project,
            "…and writing All's mode did not touch Focus's")
        XCTAssertEqual(
            storedGrouping(for: "satellite", modes: both, legacy: ""),
            BoardFilterPrefs.defaultGrouping
        )

        // Switching a tier BACK is remembered too — the map is a store, not a one-way trip.
        let back = storingGrouping(.tier, for: "focus", modes: both)
        XCTAssertEqual(storedGrouping(for: "focus", modes: back, legacy: ""), .tier)
        XCTAssertEqual(storedGrouping(for: nil, modes: back, legacy: ""), .project)
    }

    /// The single value an installed build already wrote is not discarded: it becomes the
    /// default for every tier that has no entry of its own. An explicit entry outranks it.
    func testALegacySingleGroupingValueMigratesIntoTheMap() {
        for legacy in BoardGrouping.allCases {
            for scope in [nil, "focus", "ct_abc12345"] as [String?] {
                XCTAssertEqual(
                    storedGrouping(for: scope, modes: "", legacy: legacy.rawValue), legacy,
                    "scope=\(scope ?? "All"): the stored \(legacy.rawValue) was thrown away"
                )
            }
        }
        let stored = storingGrouping(.tier, for: "focus", modes: "")
        XCTAssertEqual(storedGrouping(for: "focus", modes: stored, legacy: "project"), .tier,
            "an explicit per-tier entry outranks the legacy single value")
        XCTAssertEqual(storedGrouping(for: "satellite", modes: stored, legacy: "project"), .project,
            "…and the legacy value still covers every tier that has no entry")
    }

    /// A stored map that no longer parses (an older build, a hand-edited plist, a partly
    /// written value) falls back per ENTRY rather than throwing the whole map away.
    func testGarbageInTheGroupingMapFallsBackPerEntry() {
        for junk in [
            "", "   ", "not json", "[]", "{", "null", "42",
            "{\"focus\":\"nope\"}", "{\"focus\":7}", "{\"focus\":null}",
        ] {
            XCTAssertEqual(
                storedGrouping(for: "focus", modes: junk, legacy: ""),
                BoardFilterPrefs.defaultGrouping,
                "junk: \(junk)"
            )
        }
        let mixed = "{\"focus\":\"nope\",\"backlog\":\"project\"}"
        XCTAssertEqual(storedGrouping(for: "focus", modes: mixed, legacy: ""),
                       BoardFilterPrefs.defaultGrouping,
                       "one bad entry falls back to the default")
        XCTAssertEqual(storedGrouping(for: "backlog", modes: mixed, legacy: ""), .project,
                       "…and does not take the map's good entries with it")
    }

    // MARK: - A stale scope shows the whole board, never an empty one

    /// A scope can name a tier that is gone (a deleted custom tier) or one that emptied
    /// under the user (its last row completed, a query narrowed it away). Answering "no
    /// rows" there would be an empty board with no explanation, so the fallback is the
    /// WHOLE board and the lit chip falls back to `All` — the bar and the rows agree.
    func testAnUnknownOrEmptyScopeFallsBackToTheWholeBoard() {
        let everything = rowIds(board(scope: nil, grouping: .tier))
        for stale in ["ct_gone99", "wait", "proj:marina", "folder:g_docs", ""] {
            for grouping in BoardGrouping.allCases {
                XCTAssertEqual(
                    rowIds(board(scope: stale, grouping: grouping)), everything,
                    "\(grouping.rawValue): a scope of \"\(stale)\" emptied the board"
                )
                XCTAssertNil(honouredScope(stale, grouping: grouping),
                    "\(grouping.rawValue): \"\(stale)\" must read as All in the bar")
            }
        }
        // A KNOWN tier with no rows is the same case: `wait` is a real built-in tier the
        // fixture has no rows for, and it has no chip either.
        XCTAssertNil(rail(grouping: .tier).first { $0.bandId == "wait" },
            "an empty tier has no chip, for the same reason it has no heading")
    }

    // MARK: - The composer seed follows the scope

    /// `Add to Focus…` — the quick add reads the SCOPE directly, so it is right under
    /// both groupings. It used to derive the tier from the selected band's `createSeed`,
    /// which under `By project` was a `proj:` band and produced the default tier instead.
    func testTheQuickAddSeedFollowsTheTierScopeUnderBothGroupings() {
        for grouping in BoardGrouping.allCases {
            for scope in ["focus", "satellite", "backlog"] {
                XCTAssertEqual(
                    quickAddSeed(scope: scope, grouping: grouping).pin, .tier(scope),
                    "\(grouping.rawValue): a create under the \(scope) scope must land in \(scope)"
                )
            }
            XCTAssertEqual(
                quickAddSeed(scope: nil, grouping: grouping).pin,
                .tier(BoardModel.defaultTierId),
                "\(grouping.rawValue): All still files into the default tier"
            )
            // A scope the board did not honour must not reach the wire as a tier.
            XCTAssertEqual(
                quickAddSeed(scope: "proj:marina", grouping: grouping).pin,
                .tier(BoardModel.defaultTierId)
            )
        }
        XCTAssertTrue(
            quickAddSeed(scope: "focus", grouping: .project).pin.isResolvable(
                builtinIds: TasksStore.builtinTiers.map(\.id), customTierIds: []
            ),
            "the seed has to be something the create endpoint accepts"
        )
    }

    // MARK: - A band's create row: its words and its write

    /// What the band's create row PRINTS, and it is the view's own expression rather than
    /// a restatement of it: `TaskBoardList.createDestination` is the single place those
    /// words are decided, and `createFoot` interpolates exactly this.
    private func createWords(
        _ band: BoardBand, seed: NewTaskSeed,
        tierChoices: [(id: String, label: String)]
    ) -> String {
        TaskBoardList.createDestination(band, seed: seed, tierChoices: tierChoices)
    }

    /// The invariant: on every band that offers a create row, the WORDS on that row and
    /// the destination its SEED writes to are the same place.
    ///
    /// Checked as a relation and not as two separate facts, which is the whole point: the
    /// seed was always right on its own, and the heading was always a fine heading on its
    /// own, so a test that looks at either one alone passes while the screen lies.
    private func assertWordsMatchTheWrite(
        _ bands: [BoardBand], tierChoices: [(id: String, label: String)],
        _ context: String, file: StaticString = #filePath, line: UInt = #line
    ) {
        var checked = 0
        for band in bands {
            guard let seed = band.createSeed else {
                // The one band with no create row is a folder (v1 has no folder write),
                // and it says nothing, so it cannot say the wrong thing.
                XCTAssertTrue(
                    band.bandId.hasPrefix(BoardModel.folderBandPrefix),
                    "\(context): \(band.bandId) offers no create row and is not a folder",
                    file: file, line: line
                )
                continue
            }
            checked += 1
            let words = createWords(band, seed: seed, tierChoices: tierChoices)
            if let tier = seed.pin.wireFocusTier {
                let label = tierChoices.first { $0.id == tier }?.label ?? tier
                XCTAssertEqual(
                    words, label,
                    "\(context): \(band.bandId) says \"New task in \(words)\" and pins to \(label)",
                    file: file, line: line
                )
                // A seed that named a tier AND a project would make "the same
                // destination" ambiguous — one set of words cannot cover two writes.
                XCTAssertEqual(
                    seed.project, "",
                    "\(context): \(band.bandId) pins to a tier and files into a project",
                    file: file, line: line
                )
            } else {
                let project = seed.project.isEmpty ? NewTaskSeed.inboxHeader : seed.project
                XCTAssertEqual(
                    words, project,
                    "\(context): \(band.bandId) says \"New task in \(words)\" and files into \(project)",
                    file: file, line: line
                )
            }
        }
        XCTAssertGreaterThan(
            checked, 0, "\(context): no create row to check", file: file, line: line
        )
    }

    /// **The p1 from the adversarial pass: the create row named a destination it did not
    /// use.** A lone project heading is relabelled to the TIER it is in (`soleHeadingLabel`
    /// — with one project on screen its own name says nothing new), and the seed underneath
    /// still files into that project. Interpolating the HEADING therefore promised "New
    /// task in Focus" over a write that files into `marina`, while the row that opens
    /// directly below it read "Add to marina…": one control, two answers.
    ///
    /// The choice this pins: the relabel stays a HEADING concern, and the create row names
    /// the destination it writes to. So the words follow the seed everywhere.
    func testEveryCreateRowNamesTheDestinationItWritesTo() throws {
        let choices = TasksStore.builtinTiers

        // Every band, under both groupings, at every scope.
        for grouping in BoardGrouping.allCases {
            for scope in [nil, "focus", "satellite", "backlog"] as [String?] {
                assertWordsMatchTheWrite(
                    board(scope: scope, grouping: grouping), tierChoices: choices,
                    "grouping=\(grouping.rawValue) scope=\(scope ?? BoardModel.allChipLabel)"
                )
            }
        }

        // The reported case, in the words on the screen: Backlog holds one project, so the
        // heading reads "Backlog" (that relabel is not being undone) and the row under it
        // has to name `marina`, because `marina` is where the task goes.
        let backlog = board(scope: "backlog", grouping: .project)
        XCTAssertEqual(backlog.map(\.label), ["Backlog"],
            "one project in the tier: the heading still names the tier")
        let backlogBand = try XCTUnwrap(backlog.first)
        let backlogSeed = try XCTUnwrap(backlogBand.createSeed)
        XCTAssertEqual(backlogSeed.project, "marina", "the write is unchanged")
        XCTAssertEqual(
            createWords(backlogBand, seed: backlogSeed, tierChoices: choices), "marina",
            "\"New task in Backlog\" over a write into marina is the defect"
        )

        // The same relabel over the INBOX project, whose write is the EMPTY project: the
        // words are "Inbox" — never the tier's, and never the empty string.
        let inboxOnly = board(
            scope: "focus", grouping: .project, tasks: [task("i1"), task("i2")],
            tierOf: ["i1": "focus", "i2": "focus"], tierOrder: ["focus": ["i1", "i2"]]
        )
        XCTAssertEqual(inboxOnly.map(\.label), ["Focus"])
        let inboxBand = try XCTUnwrap(inboxOnly.first)
        let inboxSeed = try XCTUnwrap(inboxBand.createSeed)
        XCTAssertEqual(inboxSeed.project, "", "Inbox IS the empty project on the wire")
        XCTAssertEqual(
            createWords(inboxBand, seed: inboxSeed, tierChoices: choices),
            NewTaskSeed.inboxHeader,
            "the empty project has a name on screen, and it is not the tier's"
        )

        // With no scope at all the lone heading reads "All", which names no destination
        // whatsoever — so this case is not even a wrong place, it is no place.
        let wholeBoard = board(
            scope: nil, grouping: .project, tasks: [task("o1", project: "marina")],
            tierOf: ["o1": "focus"], tierOrder: ["focus": ["o1"]]
        )
        XCTAssertEqual(wholeBoard.map(\.label), [BoardModel.allChipLabel])
        let wholeBand = try XCTUnwrap(wholeBoard.first)
        XCTAssertEqual(
            createWords(
                wholeBand, seed: try XCTUnwrap(wholeBand.createSeed), tierChoices: choices
            ),
            "marina", "\"New task in All\" names nowhere"
        )
    }

    /// The two cases that were already right and have to stay right, since the fix moved
    /// where these words come from: a custom tier's ring names the tier's LABEL (never its
    /// `ct_` id), and a project that has a folder on screen keeps its own name, so the
    /// nested board has nothing to relabel and nothing to disagree about.
    func testTheWordsSurviveACustomTierAndAFolder() throws {
        let customChoices: [(id: String, label: String)] =
            TasksStore.builtinTiers + [(id: "ct_deep", label: "Deep Work")]
        let custom = assembled(
            [task("c1", project: "marina")], tierOf: ["c1": "ct_deep"],
            tierOrder: ["ct_deep": ["c1"]], scope: "ct_deep", grouping: .tier,
            customTiers: [FocusTierInfo(id: "ct_deep", label: "Deep Work")]
        ).bands
        assertWordsMatchTheWrite(custom, tierChoices: customChoices, "a custom tier")
        let customBand = try XCTUnwrap(custom.first)
        XCTAssertEqual(
            createWords(
                customBand, seed: try XCTUnwrap(customBand.createSeed),
                tierChoices: customChoices
            ),
            "Deep Work", "a ct_ id is not words"
        )

        let folders = BoardFolderIndex.build([
            TaskFolder(groupId: "g_ship", label: "Ship", memberIds: ["f1"], project: "marina"),
        ])
        let nested = board(scope: "focus", grouping: .project, folders: folders)
        XCTAssertTrue(
            nested.contains { $0.bandId == "folder:g_ship" },
            "the fixture has to actually put a folder on screen"
        )
        assertWordsMatchTheWrite(nested, tierChoices: customChoices, "a tier with a folder")
    }
}
