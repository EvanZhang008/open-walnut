import XCTest
@testable import Walnut

/// The phone's pinned board lists every tier in the MAC's order.
///
/// Reported from TestFlight build 82 (2026-09-26): the Tasks tab's Focus tier under `By
/// project` showed Inbox first and the other projects A to Z, rows by recent activity,
/// while the Mac's home panel showed the same tier in its own order. The console orders a
/// pinned tier with `orderPinnedTier` (web/src/utils/pinned-tier-order.ts); the phone now
/// runs its twin, `PinnedTierOrder`, inside `BoardModel.assemble`.
///
/// Every expected order below was PRODUCED BY THE WEB CODE:
/// `tests/web/pinned-tier-order.test.ts` runs the real `orderPinnedTier` over
/// `tests/fixtures/pinned-tier-order/cases.json` and pins `expected.json`, which this
/// suite replays through the Swift twin AND through the real board assembly. A
/// hand-written order would only prove the twin agrees with its author.
@MainActor
final class PinnedTierOrderTests: XCTestCase {

    // MARK: - The fixture

    private struct Cases: Decodable {
        struct Case: Decodable {
            let name: String
            let mode: String
            let projectOrder: [String]
            let rows: [Row]
        }
        struct Row: Decodable {
            let id: String
            let project: String?
            let group_id: String?
        }
        struct Board: Decodable {
            let now: String
            let customTiers: [FocusTierInfo]
            let projectOrder: [String]
            let groups: [TaskFolder]
            let tasks: [WalnutTask]
        }
        let cases: [Case]
        let board: Board
    }

    private struct Expected: Decodable {
        struct Run: Decodable, Equatable {
            let project: String
            let folder: String?
        }
        struct View: Decodable {
            let ids: [String]
            let runs: [Run]
            let showDone: [String]
        }
        struct Board: Decodable {
            let split: FocusTierResult
            let views: [String: View]
        }
        let cases: [String: [String]]
        let board: Board
    }

    private static let fixtureDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()      // WalnutTests/
        .deletingLastPathComponent()      // ios-native/
        .deletingLastPathComponent()      // repo root
        .appendingPathComponent("tests/fixtures/pinned-tier-order")

    private func load<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        let data = try Data(contentsOf: Self.fixtureDir.appendingPathComponent(name))
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: - The twin, case by case

    func testTheTwinOrdersEveryCaseExactlyAsTheWebDoes() throws {
        let fixture = try load("cases.json", as: Cases.self)
        let expected = try load("expected.json", as: Expected.self)
        XCTAssertFalse(fixture.cases.isEmpty)
        for item in fixture.cases {
            let rows = item.rows.map {
                PinnedTierOrder.Row(id: $0.id, project: $0.project ?? "", folder: $0.group_id)
            }
            let mode = try XCTUnwrap(PinnedTierOrder.Mode(rawValue: item.mode))
            XCTAssertEqual(
                PinnedTierOrder.order(rows, mode: mode, projectOrder: item.projectOrder),
                expected.cases[item.name], item.name
            )
        }
    }

    /// The two string rules the twin copies from JavaScript, on the inputs where Swift's
    /// own would answer differently.
    func testProjectIdentityAndCaseFoldAreJavaScripts() {
        // Canonically equivalent, different code units: two projects on the web.
        XCTAssertNotEqual(PinnedTierOrder.Exact("Caf\u{E9}"), PinnedTierOrder.Exact("Cafe\u{301}"))
        XCTAssertEqual("Caf\u{E9}", "Cafe\u{301}", "Swift's own == would merge them")
        // JS toLowerCase applies the Greek final-sigma rule; String.lowercased() does not.
        XCTAssertEqual(PinnedTierOrder.jsLowercased("\u{39F}\u{394}\u{39F}\u{3A3}"), "\u{3BF}\u{3B4}\u{3BF}\u{3C2}")
        XCTAssertNotEqual("\u{39F}\u{394}\u{39F}\u{3A3}".lowercased(), "\u{3BF}\u{3B4}\u{3BF}\u{3C2}")
    }

    // MARK: - The board, every tier × mode × date

    private struct Board {
        let tasks: [WalnutTask]
        let tierOf: [String: String]
        let tierOrder: [String: [String]]
        let customTiers: [FocusTierInfo]
        let folders: BoardFolderIndex
        let projectOrder: [String]
        let now: Date
        let views: [String: Expected.View]
    }

    private func board() throws -> Board {
        let fixture = try load("cases.json", as: Cases.self)
        let expected = try load("expected.json", as: Expected.self)
        let split = expected.board.split
        return Board(
            tasks: fixture.board.tasks,
            tierOf: TasksStore.tierMap(from: split),
            tierOrder: TasksStore.tierOrder(from: split),
            customTiers: fixture.board.customTiers,
            folders: BoardFolderIndex.build(fixture.board.groups),
            projectOrder: fixture.board.projectOrder,
            now: try XCTUnwrap(WalnutTask.parseISO(fixture.board.now)),
            views: expected.board.views
        )
    }

    private func assemble(
        _ board: Board, key: String, showDone: Bool = false
    ) throws -> BoardAssembly {
        let parts = key.split(separator: "/").map(String.init)
        XCTAssertEqual(parts.count, 3, key)
        return BoardModel.assemble(
            tasks: board.tasks, sessions: [],
            tierOf: board.tierOf, tierOrder: board.tierOrder, customTiers: board.customTiers,
            grouping: parts[1] == "project" ? .project : .tier,
            dateFilter: parts[2] == "now" ? .now : .all,
            showDone: showDone,
            folders: board.folders,
            scope: parts[0] == "all" ? nil : parts[0],
            projectOrder: board.projectOrder,
            now: board.now
        )
    }

    /// A group as band ids: its project's band and its folder (nil = the loose rows).
    private struct Group: Equatable {
        let projectBandId: String
        let folder: String?
    }

    /// The group a band draws.
    private func group(_ band: BoardBand) -> Group {
        Group(projectBandId: band.nest?.projectBandId ?? band.bandId, folder: band.nest?.folderId)
    }

    /// The web fixture's run, in the same vocabulary.
    private func group(_ run: Expected.Run) -> Group {
        Group(projectBandId: BoardModel.projectBandId(run.project), folder: run.folder)
    }

    /// One flat walk of the web's contiguous runs, merged the way the phone's bands group
    /// them: the console's runs ARE the phone's bands, one to one.
    func testEveryTierModeAndDateShowsTheMacsOrder() throws {
        let board = try board()
        XCTAssertEqual(board.views.count, 24, "6 scopes x 2 modes x 2 dates")
        for key in board.views.keys.sorted() {
            let view = try XCTUnwrap(board.views[key])
            let assembly = try assemble(board, key: key)
            XCTAssertEqual(assembly.bands.flatMap { $0.rows.map(\.id) }, view.ids, key)
            // One SwiftUI identity per band under Swift's OWN string equality, or
            // `ForEach` draws one of two canonically equal ids and drops the other's rows
            // (the fixture has `Café Nord` precomposed and decomposed, two projects).
            XCTAssertEqual(Set(assembly.bands.map(\.id)).count, assembly.bands.count, "\(key): band identities")
            guard key.contains("/project/") else { continue }
            XCTAssertEqual(
                assembly.bands.filter { !$0.rows.isEmpty }.map { group($0) }, view.runs.map { group($0) },
                "\(key): the groups, in order"
            )
        }
    }

    /// `Show done` on: each completed row is drawn in its pin place inside its own group
    /// (a group only completed rows have comes last), and no open row moves.
    func testShowDoneKeepsCompletedRowsInTheirPinPlace() throws {
        let board = try board()
        for key in board.views.keys.sorted() {
            let view = try XCTUnwrap(board.views[key])
            let open = try assemble(board, key: key, showDone: true)
            XCTAssertEqual(open.bands.flatMap { $0.rows.map(\.id) }, view.showDone, key)
        }
    }

    /// The same rows reach both groupings, so switching the chip never loses a task.
    func testBothGroupingsDrawTheSameRows() throws {
        let board = try board()
        for scope in ["focus", "satellite", "backlog", "wait", "ct_later", "all"] {
            for date in ["all", "now"] {
                let tier = try assemble(board, key: "\(scope)/custom/\(date)")
                let project = try assemble(board, key: "\(scope)/project/\(date)")
                XCTAssertEqual(
                    Set(tier.bands.flatMap { $0.rows.map(\.id) }),
                    Set(project.bands.flatMap { $0.rows.map(\.id) }), "\(scope)/\(date)"
                )
            }
        }
    }

    /// A pin reordered on the Mac (a new `pin_order`, which the split carries in order)
    /// moves on the phone the same way: the fixture's first two Focus rows, swapped.
    func testAReorderOnTheMacIsTheReorderOnThePhone() throws {
        let board = try board()
        let before = try assemble(board, key: "focus/custom/all").bands.flatMap { $0.rows.map(\.id) }
        XCTAssertGreaterThanOrEqual(before.count, 2)
        var reordered = board.tierOrder
        var focus = try XCTUnwrap(reordered["focus"])
        let first = try XCTUnwrap(focus.firstIndex(of: before[0]))
        let second = try XCTUnwrap(focus.firstIndex(of: before[1]))
        focus.swapAt(first, second)
        reordered["focus"] = focus
        let swapped = Board(
            tasks: board.tasks, tierOf: board.tierOf, tierOrder: reordered,
            customTiers: board.customTiers, folders: board.folders,
            projectOrder: board.projectOrder, now: board.now, views: board.views
        )
        let after = try assemble(swapped, key: "focus/custom/all").bands.flatMap { $0.rows.map(\.id) }
        XCTAssertEqual(Array(after.prefix(2)), [before[1], before[0]])
    }

    /// An old replica answers no project order and no folders. The board then shows the
    /// order the console itself would draw with neither: projects where their first row
    /// appears, rows in pin order, no folder blocks.
    func testWithoutOrderOrFoldersProjectsFollowTheirFirstRow() throws {
        let board = try board()
        let bare = Board(
            tasks: board.tasks, tierOf: board.tierOf, tierOrder: board.tierOrder,
            customTiers: board.customTiers, folders: .empty, projectOrder: [],
            now: board.now, views: board.views
        )
        let ids = try assemble(bare, key: "focus/project/all").bands.flatMap { $0.rows.map(\.id) }
        let pinOrder = board.tierOrder["focus"] ?? []
        let byId = Dictionary(uniqueKeysWithValues: board.tasks.map { ($0.id, $0) })
        let openInPinOrder = pinOrder.filter { byId[$0]?.isDone == false }
        var projects: [String] = []
        for id in openInPinOrder {
            let project = byId[id]?.project ?? ""
            if !projects.contains(project) { projects.append(project) }
        }
        let expected = projects.flatMap { project in
            openInPinOrder.filter { byId[$0]?.project == project }
        }
        XCTAssertEqual(ids, expected)
    }

    // MARK: - Nested folders (the console's pinned tiers draw folders flat)

    /// A subfolder is drawn INSIDE its parent, so a parent takes the place of the first row
    /// anywhere in its subtree. Without nesting that is exactly the console's order.
    func testANestedFolderKeepsItsParentAtTheSubtreesFirstPlace() {
        let folders = BoardFolderIndex.build([
            TaskFolder(groupId: "g_parent", label: "Parent", memberIds: ["p1"], project: "acme"),
            TaskFolder(groupId: "g_child", label: "Child", memberIds: ["c1"], project: "acme",
                       parentId: "g_parent"),
            TaskFolder(groupId: "g_other", label: "Other", memberIds: ["o1"], project: "acme"),
        ])
        // First appearances: child, other, parent.
        XCTAssertEqual(
            BoardModel.folderOrder(withRows: ["g_child", "g_other", "g_parent"], folders: folders),
            ["g_parent", "g_child", "g_other"]
        )
        XCTAssertEqual(
            BoardModel.folderOrder(withRows: ["g_other", "g_child"], folders: .empty),
            ["g_other", "g_child"], "flat folders keep their first appearance"
        )
    }
}
