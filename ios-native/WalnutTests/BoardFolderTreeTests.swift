import XCTest
@testable import Walnut

/// The board's folder TREE: `parent_id` rendered as nesting instead of as one flat level.
///
/// The data always carried the hierarchy (`TaskFolder.parentId`, server-capped at
/// `FOLDER_MAX_DEPTH`); the board drew every folder of a project as a sibling, so a
/// subfolder read as a peer of its own parent. These cases pin the tree AND, more
/// importantly, the one failure mode that would be worse than a flat board:
///
///   **A FOLDER'S ROWS ARE NEVER INVISIBLE.** Whatever the hierarchy says — a parent that
///   does not exist, a parent in another project, a folder that is its own parent, a cycle,
///   a chain deeper than the server would ever store — every row still gets a band. Half of
///   this file exists to assert exactly that.
final class BoardFolderTreeTests: XCTestCase {

    private static let now = WalnutTask.parseISO("2026-08-27T12:00:00Z")!

    private func task(_ id: String, project: String = "marina") -> WalnutTask {
        WalnutTask(
            id: id, title: "task \(id)", status: "todo", phase: "TODO",
            priority: "none", project: project, dueDate: nil,
            createdAt: "2026-08-27T00:00:00Z", updatedAt: "2026-08-27T00:00:00Z",
            completedAt: nil, starred: nil, pinned: true, tags: nil, summary: nil,
            startDate: nil
        )
    }

    /// A COMPLETED pinned row. Done folds by default, so this is how the fixture below can
    /// tell "the board is hiding this row" apart from "the board lost this row".
    private func done(_ id: String, project: String = "marina") -> WalnutTask {
        WalnutTask(
            id: id, title: "task \(id)", status: "done", phase: "COMPLETE",
            priority: "none", project: project, dueDate: nil,
            createdAt: "2026-08-27T00:00:00Z", updatedAt: "2026-08-27T00:00:00Z",
            completedAt: "2026-08-27T01:00:00Z", starred: nil, pinned: true, tags: nil,
            summary: nil, startDate: nil
        )
    }

    private func bands(
        _ tasks: [WalnutTask], _ folders: [TaskFolder]
    ) -> [BoardBand] {
        BoardModel.bands(
            tasks: tasks, sessions: [], tierOf: [:], tierOrder: [:], customTiers: [],
            grouping: .project, folders: BoardFolderIndex.build(folders), now: Self.now
        )
    }

    /// Every row the fixture pins, as the set the board must render — the assertion that
    /// makes every "broken hierarchy" case below a rendering question rather than a data-loss
    /// question.
    private func assertEveryRowIsRendered(
        _ bands: [BoardBand], _ tasks: [WalnutTask], _ message: String = ""
    ) {
        let rendered = Set(bands.flatMap { $0.rows.map(\.id) })
        XCTAssertEqual(
            rendered, Set(tasks.map(\.id)),
            "a pinned row vanished from the board\(message.isEmpty ? "" : " — \(message)")"
        )
    }

    private func folderBand(_ bands: [BoardBand], _ folderId: String) -> BoardBand? {
        bands.first { $0.nest?.folderId == folderId }
    }

    // MARK: - The tree, rendered

    /// A subfolder's band comes IMMEDIATELY AFTER its parent's, one level deeper. Pre-order,
    /// which is what puts a child's rows inside the parent it belongs to instead of after
    /// every sibling.
    func testASubfolderIsRenderedInsideItsParentAndOneLevelDeeper() {
        let tasks = [task("m1"), task("m2"), task("m3")]
        let folders = [
            TaskFolder(groupId: "g_ship", label: "Ship", memberIds: ["m2"], project: "marina"),
            TaskFolder(
                groupId: "g_docs", label: "Docs", memberIds: ["m3"], project: "marina",
                parentId: "g_ship"
            ),
        ]
        let built = bands(tasks, folders)
        XCTAssertEqual(
            built.map(\.bandId),
            ["proj:marina", "folder:g_ship", "folder:g_docs"],
            "the child has to follow its parent, not sort as a sibling"
        )
        XCTAssertEqual(folderBand(built, "g_ship")?.nest?.depth, 1)
        XCTAssertEqual(folderBand(built, "g_docs")?.nest?.depth, 2)
        XCTAssertEqual(
            folderBand(built, "g_docs")?.nest?.ancestors.map(\.folderId), ["g_ship"]
        )
        XCTAssertEqual(
            folderBand(built, "g_docs")?.nest?.ancestors.map(\.label), ["Ship"],
            "the ancestor step carries the LABEL, because the heading may have to draw it"
        )
        // The parent's own band is on screen, so the child draws no stand-in heading.
        XCTAssertEqual(folderBand(built, "g_docs")?.nest?.leadFolders, [])
        assertEveryRowIsRendered(built, tasks)
    }

    /// Pre-order, stated where it differs from an alphabetical list: `Zed` is a CHILD of
    /// `Alpha`, so it comes before the root folder `Beta` even though its label sorts last.
    func testTheOrderIsThePreOrderWalkAndNotAnAlphabeticalList() {
        let tasks = [task("m1"), task("m2"), task("m3"), task("m4")]
        let folders = [
            TaskFolder(groupId: "g_alpha", label: "Alpha", memberIds: ["m2"], project: "marina"),
            TaskFolder(groupId: "g_beta", label: "Beta", memberIds: ["m3"], project: "marina"),
            TaskFolder(
                groupId: "g_zed", label: "Zed", memberIds: ["m4"], project: "marina",
                parentId: "g_alpha"
            ),
        ]
        let built = bands(tasks, folders)
        XCTAssertEqual(
            built.map(\.bandId),
            ["proj:marina", "folder:g_alpha", "folder:g_zed", "folder:g_beta"]
        )
        assertEveryRowIsRendered(built, tasks)
    }

    /// A parent folder holding no pinned rows gets no band (the board's existing empty-band
    /// rule), so its child draws the parent's name as a stand-in heading — otherwise the
    /// child's indent would claim to be inside something the screen never named.
    func testAChildOfAnEmptyParentStillShowsTheParentsName() {
        let tasks = [task("m1")]
        let folders = [
            TaskFolder(groupId: "g_ship", label: "Ship", memberIds: [], project: "marina"),
            TaskFolder(
                groupId: "g_docs", label: "Docs", memberIds: ["m1"], project: "marina",
                parentId: "g_ship"
            ),
        ]
        let built = bands(tasks, folders)
        XCTAssertEqual(built.map(\.bandId), ["folder:g_docs"], "the empty parent has no band")
        let nest = folderBand(built, "g_docs")?.nest
        XCTAssertEqual(nest?.depth, 2)
        XCTAssertEqual(nest?.leadFolders.map(\.label), ["Ship"])
        XCTAssertEqual(nest?.leadFolders.map(\.depth), [1], "the stand-in draws at ITS own depth")
        XCTAssertEqual(nest?.leadsProject, true, "and the project heading rides it too")
        assertEveryRowIsRendered(built, tasks)
    }

    /// A subfolder left ALONE on screen still carries its whole context: the project
    /// heading and the parent folder's name. `relead` exists for exactly this.
    ///
    /// The state used to be reached by selecting the subfolder's own CHIP. There is no
    /// folder chip any more — the rail is always the tier rail — so it is reached the way it
    /// actually happens now: a TIER scope in which only the subfolder has rows. The project
    /// band and the parent folder's band are both dropped for being empty, and the survivor
    /// has to draw both of their names.
    func testASubfolderAloneOnScreenKeepsItsWholeContext() {
        let tasks = [task("m1"), task("m2"), task("m3")]
        let folders = [
            TaskFolder(groupId: "g_ship", label: "Ship", memberIds: ["m2"], project: "marina"),
            TaskFolder(
                groupId: "g_docs", label: "Docs", memberIds: ["m3"], project: "marina",
                parentId: "g_ship"
            ),
        ]
        let only = BoardModel.assemble(
            tasks: tasks, sessions: [],
            tierOf: ["m1": "backlog", "m2": "backlog", "m3": "focus"],
            tierOrder: ["backlog": ["m1", "m2"], "focus": ["m3"]], customTiers: [],
            grouping: .project, folders: BoardFolderIndex.build(folders),
            scope: "focus", now: Self.now
        ).bands
        XCTAssertEqual(only.map(\.bandId), ["folder:g_docs"])
        XCTAssertEqual(only.first?.nest?.leadsProject, true)
        XCTAssertEqual(only.first?.nest?.leadFolders.map(\.label), ["Ship"])
        XCTAssertEqual(only.first?.rows.map(\.id), ["m3"])
    }

    // MARK: - Broken hierarchies: a root, never a dropped band

    /// The ORPHAN, and the worst failure this file guards: a folder whose parent is not in
    /// the listing at all (deleted, hidden from the response, a stale id). Its rows are real
    /// and they must be on the board — at the top level of their project.
    func testAnOrphanFoldersRowsAreStillOnTheBoard() {
        let tasks = [task("m1"), task("m2")]
        let folders = [
            TaskFolder(
                groupId: "g_docs", label: "Docs", memberIds: ["m2"], project: "marina",
                parentId: "g_gone"
            ),
        ]
        let built = bands(tasks, folders)
        XCTAssertEqual(built.map(\.bandId), ["proj:marina", "folder:g_docs"])
        XCTAssertEqual(folderBand(built, "g_docs")?.nest?.depth, 1, "an orphan is a root")
        XCTAssertEqual(folderBand(built, "g_docs")?.nest?.ancestors, [])
        XCTAssertEqual(folderBand(built, "g_docs")?.rows.map(\.id), ["m2"])
        assertEveryRowIsRendered(built, tasks, "orphan folder")
    }

    /// A folder naming ITSELF as its parent. Infinite indent in the naive rendering; a root
    /// here.
    func testASelfParentedFolderIsARoot() {
        let tasks = [task("m1")]
        let folders = [
            TaskFolder(
                groupId: "g_docs", label: "Docs", memberIds: ["m1"], project: "marina",
                parentId: "g_docs"
            ),
        ]
        let index = BoardFolderIndex.build(folders)
        XCTAssertNil(index.parentOf["g_docs"])
        XCTAssertEqual(index.depth(of: "g_docs"), 1)
        let built = bands(tasks, folders)
        XCTAssertEqual(built.map(\.bandId), ["folder:g_docs"])
        assertEveryRowIsRendered(built, tasks, "self-parented folder")
    }

    /// A CYCLE (two folders naming each other). The tree is broken deterministically, every
    /// row is rendered, and — the part that matters for any code that walks the chain — no
    /// folder ends up its own ancestor.
    func testACycleIsBrokenWithoutLosingARow() {
        let tasks = [task("m1"), task("m2")]
        let folders = [
            TaskFolder(
                groupId: "g_a", label: "Ay", memberIds: ["m1"], project: "marina",
                parentId: "g_b"
            ),
            TaskFolder(
                groupId: "g_b", label: "Bee", memberIds: ["m2"], project: "marina",
                parentId: "g_a"
            ),
        ]
        let index = BoardFolderIndex.build(folders)
        for id in ["g_a", "g_b"] {
            XCTAssertFalse(
                index.ancestors(of: id).contains(id), "\(id) is its own ancestor"
            )
            XCTAssertLessThanOrEqual(index.depth(of: id), BoardFolderIndex.maxDepth)
        }
        let built = bands(tasks, folders)
        XCTAssertEqual(Set(built.map(\.bandId)), ["folder:g_a", "folder:g_b"])
        assertEveryRowIsRendered(built, tasks, "cyclic folders")
        // Same input, same tree: a drifted store must not shuffle rows between two
        // headings on every refresh.
        XCTAssertEqual(bands(tasks, folders).map(\.bandId), built.map(\.bandId))
        XCTAssertEqual(BoardFolderIndex.build(folders), index)
    }

    /// A three-folder cycle, because a two-cycle can be broken by accident and a longer one
    /// cannot.
    func testAThreeFolderCycleIsAlsoBroken() {
        let tasks = [task("m1"), task("m2"), task("m3")]
        let folders = [
            TaskFolder(groupId: "g_a", label: "Ay", memberIds: ["m1"], project: "marina", parentId: "g_b"),
            TaskFolder(groupId: "g_b", label: "Bee", memberIds: ["m2"], project: "marina", parentId: "g_c"),
            TaskFolder(groupId: "g_c", label: "Cee", memberIds: ["m3"], project: "marina", parentId: "g_a"),
        ]
        let index = BoardFolderIndex.build(folders)
        for id in ["g_a", "g_b", "g_c"] {
            XCTAssertFalse(index.ancestors(of: id).contains(id), "\(id) is its own ancestor")
        }
        let built = bands(tasks, folders)
        XCTAssertEqual(built.count, 3)
        assertEveryRowIsRendered(built, tasks, "three-folder cycle")
    }

    /// A parent in ANOTHER project. The server refuses that nest on write (a folder can only
    /// nest inside a folder of the same project), so a stored one is drift — and nesting it
    /// anyway would draw one project's folder heading inside another project's section.
    func testAParentInAnotherProjectIsNotHonoured() {
        let tasks = [task("m1"), task("a1", project: "acme")]
        let folders = [
            TaskFolder(groupId: "g_ship", label: "Ship", memberIds: ["m1"], project: "marina"),
            TaskFolder(
                groupId: "g_cats", label: "Cats", memberIds: ["a1"], project: "acme",
                parentId: "g_ship"
            ),
        ]
        let index = BoardFolderIndex.build(folders)
        XCTAssertNil(index.parentOf["g_cats"], "cross-project nesting is drift, not a tree")
        let built = bands(tasks, folders)
        XCTAssertEqual(folderBand(built, "g_cats")?.nest?.depth, 1)
        XCTAssertEqual(folderBand(built, "g_cats")?.nest?.projectBandId, "proj:acme")
        assertEveryRowIsRendered(built, tasks, "cross-project parent")
    }

    // MARK: - Depth

    /// The server caps a chain at `FOLDER_MAX_DEPTH`; the phone mirrors the cap so a chain
    /// that got deeper through drift is drawn CLAMPED rather than indented off the screen —
    /// and every band is still rendered, because a row's visibility is not negotiable.
    func testAChainDeeperThanTheServerCapIsClampedAndNotDropped() {
        let depth = BoardFolderIndex.maxDepth + 2
        var folders: [TaskFolder] = []
        var tasks: [WalnutTask] = [task("m0")]
        for level in 1...depth {
            tasks.append(task("m\(level)"))
            folders.append(TaskFolder(
                groupId: "g\(level)", label: "Level \(level)", memberIds: ["m\(level)"],
                project: "marina", parentId: level == 1 ? nil : "g\(level - 1)"
            ))
        }
        let built = bands(tasks, folders)
        XCTAssertEqual(
            built.map(\.bandId),
            ["proj:marina"] + (1...depth).map { "folder:g\($0)" },
            "the chain has to render in order, however deep it got"
        )
        for level in 1...depth {
            let rendered = folderBand(built, "g\(level)")?.nest?.depth
            XCTAssertEqual(
                rendered, min(level, BoardFolderIndex.maxDepth),
                "level \(level) drew at depth \(rendered ?? -1)"
            )
        }
        assertEveryRowIsRendered(built, tasks, "over-deep chain")
    }

    /// The indent is a straight multiple of one step, and depth 1 is flush with where a
    /// one-level folder heading has always been drawn — so nesting cannot move the existing
    /// look of an unnested board.
    func testTheIndentIsOneStepPerLevelAndDepthOneIsUnchanged() {
        XCTAssertEqual(TaskBoardList.folderIndent(depth: 1), 0)
        XCTAssertEqual(
            TaskBoardList.folderIndent(depth: 2), TaskBoardList.folderIndentStep, accuracy: 0.01
        )
        XCTAssertEqual(
            TaskBoardList.folderIndent(depth: 3),
            2 * TaskBoardList.folderIndentStep, accuracy: 0.01
        )
        // A degenerate depth is flush, never negative: a negative leading inset would pull
        // the heading out of the card's content column.
        XCTAssertEqual(TaskBoardList.folderIndent(depth: 0), 0)
        XCTAssertGreaterThan(TaskBoardList.folderIndentStep, 8, "a step nobody can see is not a step")
    }

    // MARK: - Duplicate labels, and other ties

    /// Two sibling folders with the SAME label still order deterministically (id as the
    /// tie-break) and keep their own rows. Identical-looking headings that swap places
    /// between rebuilds is how a row appears to move on its own.
    func testTwoSiblingsSharingALabelStayDistinctAndOrderedById() {
        let tasks = [task("m1"), task("m2"), task("m3")]
        let folders = [
            TaskFolder(groupId: "g_ship", label: "Ship", memberIds: ["m1"], project: "marina"),
            TaskFolder(
                groupId: "g_two", label: "Notes", memberIds: ["m3"], project: "marina",
                parentId: "g_ship"
            ),
            TaskFolder(
                groupId: "g_one", label: "Notes", memberIds: ["m2"], project: "marina",
                parentId: "g_ship"
            ),
        ]
        let built = bands(tasks, folders)
        XCTAssertEqual(
            built.map(\.bandId),
            ["folder:g_ship", "folder:g_one", "folder:g_two"],
            "same label, so the id decides — and it decides the same way every time"
        )
        XCTAssertEqual(folderBand(built, "g_one")?.rows.map(\.id), ["m2"])
        XCTAssertEqual(folderBand(built, "g_two")?.rows.map(\.id), ["m3"])
        XCTAssertEqual(folderBand(built, "g_one")?.nest?.depth, 2)
        XCTAssertEqual(folderBand(built, "g_two")?.nest?.depth, 2)
        assertEveryRowIsRendered(built, tasks, "duplicate sibling labels")
    }

    /// A folder with no rows anywhere renders no band — unchanged by nesting, and stated
    /// here because the tree walk now visits such folders (as ancestors) and must still not
    /// draw them.
    func testAFolderWithNoRowsRendersNoBand() {
        let tasks = [task("m1")]
        let folders = [
            TaskFolder(groupId: "g_empty", label: "Empty", memberIds: [], project: "marina"),
            TaskFolder(
                groupId: "g_alsoEmpty", label: "Also empty", memberIds: [], project: "marina",
                parentId: "g_empty"
            ),
        ]
        let built = bands(tasks, folders)
        XCTAssertEqual(built.map(\.bandId), ["proj:marina"])
        assertEveryRowIsRendered(built, tasks)
    }

    // MARK: - The board-wide invariant

    /// Whatever the hierarchy, the project grouping and the tier grouping render the SAME SET
    /// of rows — asserted in BOTH fold states, because that claim is only true when the two
    /// boards are folded the same way.
    ///
    /// The narrowing is a 2026-09-02 review finding, and it is a real limit rather than
    /// pedantry: the fold set (`shownDoneTiers`) is keyed by BAND ID, and band ids are
    /// namespaced per grouping (tier ids under `.tier`, `proj:` / `folder:` under `.project`),
    /// so one grouping can genuinely be showing done rows that the other is hiding. What this
    /// used to assert — one row set, unconditionally — was therefore stronger than the code.
    /// What holds is asserted here instead: fully folded (the default, and what the board opens
    /// in) the two agree; fully expanded, each with its OWN band ids, they agree again; and the
    /// difference between the two states is exactly the done rows, in both groupings.
    func testTheTwoGroupingsRenderTheSameRowsFoldedAndExpanded() {
        let tasks = [
            task("m1"), task("m2"), task("m3"), task("m4"), task("a1", project: "acme"),
            // A DONE pinned row in a folder, which is what makes the fold state matter at all.
            done("m5"),
        ]
        let trees: [(String, [TaskFolder])] = [
            ("a plain nest", [
                TaskFolder(groupId: "g_a", label: "Ay", memberIds: ["m2"], project: "marina"),
                // The done row lives in the SUBFOLDER here, so the fold state is being
                // exercised on a nested band and not only on a project's loose rows.
                TaskFolder(
                    groupId: "g_b", label: "Bee", memberIds: ["m3", "m5"], project: "marina",
                    parentId: "g_a"
                ),
            ]),
            ("an orphan", [
                TaskFolder(groupId: "g_b", label: "Bee", memberIds: ["m3"], project: "marina", parentId: "g_gone"),
            ]),
            ("a cycle", [
                TaskFolder(groupId: "g_a", label: "Ay", memberIds: ["m2"], project: "marina", parentId: "g_b"),
                TaskFolder(groupId: "g_b", label: "Bee", memberIds: ["m3"], project: "marina", parentId: "g_a"),
            ]),
            ("a cross-project parent", [
                TaskFolder(groupId: "g_a", label: "Ay", memberIds: ["m2"], project: "marina"),
                TaskFolder(groupId: "g_c", label: "Cee", memberIds: ["a1"], project: "acme", parentId: "g_a"),
            ]),
            ("an over-deep chain", (1...(BoardFolderIndex.maxDepth + 2)).map { level in
                TaskFolder(
                    groupId: "g\(level)", label: "Level \(level)",
                    memberIds: level <= 4 ? ["m\(level)"] : [], project: "marina",
                    parentId: level == 1 ? nil : "g\(level - 1)"
                )
            }),
        ]
        let everyId = Set(tasks.map(\.id))
        for (name, folders) in trees {
            let index = BoardFolderIndex.build(folders)

            /// The board as it OPENS (done folded), and then with every band of THAT grouping
            /// expanded — the fold set is per-grouping because band ids are.
            func board(_ grouping: BoardGrouping, expanded: Bool) -> [BoardBand] {
                let folded = BoardModel.bands(
                    tasks: tasks, sessions: [], tierOf: [:], tierOrder: [:], customTiers: [],
                    grouping: grouping, folders: index, now: Self.now
                )
                guard expanded else { return folded }
                return BoardModel.bands(
                    tasks: tasks, sessions: [], tierOf: [:], tierOrder: [:], customTiers: [],
                    grouping: grouping, shownDoneTiers: Set(folded.map(\.bandId)),
                    folders: index, now: Self.now
                )
            }
            func rows(_ bands: [BoardBand]) -> [String] { bands.flatMap { $0.rows.map(\.id) } }

            for expanded in [false, true] {
                let byProject = board(.project, expanded: expanded)
                let byTier = board(.tier, expanded: expanded)
                let state = expanded ? "expanded" : "folded"
                XCTAssertEqual(
                    Set(rows(byProject)), Set(rows(byTier)),
                    "\(name), \(state): the two groupings disagree about which rows exist"
                )
                // And no row is rendered TWICE — one folder claims a task, so one band draws it.
                for (grouping, ids) in [("project", rows(byProject)), ("tier", rows(byTier))] {
                    XCTAssertEqual(
                        ids.count, Set(ids).count,
                        "\(name), \(state), \(grouping): a row is on the board twice"
                    )
                }
            }

            // Expanding adds exactly the done rows, in BOTH groupings — the honest form of
            // "no row is ever lost": what the folded board hides, `hiddenDone` counts and one
            // tap brings back.
            for grouping in BoardGrouping.allCases {
                let folded = board(grouping, expanded: false)
                let expanded = board(grouping, expanded: true)
                XCTAssertEqual(
                    Set(rows(expanded)), everyId,
                    "\(name), \(grouping.rawValue): expanding every band has to show every row"
                )
                XCTAssertEqual(
                    Set(rows(expanded)).subtracting(Set(rows(folded))), ["m5"],
                    "\(name), \(grouping.rawValue): folding hides exactly the done rows"
                )
                XCTAssertEqual(
                    folded.reduce(0) { $0 + $1.hiddenDone }, 1,
                    "\(name), \(grouping.rawValue): the hidden row is not counted on any heading"
                )
                XCTAssertEqual(
                    expanded.reduce(0) { $0 + $1.hiddenDone }, 0,
                    "\(name), \(grouping.rawValue): an expanded band still claims to hide rows"
                )
            }
        }
    }

    /// Every nested band is REACHABLE from the bar, which is a different sentence than it
    /// used to be and is the point of this round.
    ///
    /// It used to say "a subfolder gets its own chip". That was the shape the user rejected:
    /// switching to `By project` turned the rail into a list of projects and folders, so
    /// reaching one folder meant several taps and the tier you were in was lost. The rail is
    /// the TIER rail now, and reachability means what it should: every rendered band's rows
    /// belong to a tier the rail HAS a chip for, and selecting that chip leaves the band on
    /// screen with its rows intact — in ONE scrollable list, no extra taps.
    func testEveryNestedBandIsReachableThroughItsTierChip() {
        let tasks = [task("m1"), task("m2"), task("m3")]
        let folders = BoardFolderIndex.build([
            TaskFolder(groupId: "g_ship", label: "Ship", memberIds: ["m2"], project: "marina"),
            TaskFolder(
                groupId: "g_docs", label: "Docs", memberIds: ["m3"], project: "marina",
                parentId: "g_ship"
            ),
        ])
        let tierOf = ["m1": "focus", "m2": "focus", "m3": "focus"]
        let tierOrder = ["focus": ["m1", "m2", "m3"]]
        func assembled(_ scope: String?) -> BoardAssembly {
            BoardModel.assemble(
                tasks: tasks, sessions: [], tierOf: tierOf, tierOrder: tierOrder,
                customTiers: [], grouping: .project, folders: folders, scope: scope,
                now: Self.now
            )
        }
        let whole = assembled(nil)
        XCTAssertEqual(whole.bands.map(\.bandId),
                       ["proj:marina", "folder:g_ship", "folder:g_docs"])
        // The rail is tiers, `All` first — never one chip per band.
        XCTAssertEqual(whole.rail.first?.bandId, nil, "the All chip still leads")
        XCTAssertEqual(whole.rail.compactMap(\.bandId), ["focus"])

        // Selecting the one tier chip keeps every nested band, rows and all.
        let scoped = assembled("focus")
        XCTAssertEqual(scoped.bands.map(\.bandId), whole.bands.map(\.bandId),
            "every folder of the tier is still a heading in one list")
        XCTAssertEqual(
            Set(scoped.bands.flatMap { $0.rows.map(\.id) }),
            Set(tasks.map(\.id)),
            "and no row is unreachable"
        )
    }
}
