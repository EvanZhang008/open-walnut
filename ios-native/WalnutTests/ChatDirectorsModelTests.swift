import XCTest
@testable import Walnut

/// Directors in the Chat drawer (ChatDirectorsModel), the twin of the server's `directorsOf`
/// (src/core/org/org-directors.ts): which tasks under a VP are Directors, nested ones a level
/// deeper, a non-Director in between transparent, each task once; and the two layouts.
final class ChatDirectorsModelTests: XCTestCase {
    /// `GET /api/v1/org` with Directors: Walnut's VP also leads Garden; under "Platform" (no
    /// Director) sits a Director, and a Director nests another. Ops has none.
    private static let json = """
    {"tree":{"main":{"id":"main-1","title":"Main","phase":"IN_PROGRESS"},
    "counts":{"open":9,"running":2,"needsYou":1,"waiting":6},
    "projects":[
     {"project":"Walnut","lead":{"id":"lead-w","title":"Walnut VP","phase":"IN_PROGRESS"},"contactId":"lead-w","vp":null,
      "counts":{"open":6,"running":2,"needsYou":1,"waiting":3},
      "teams":[
       {"kind":"task","id":"d1","title":"Search rewrite","project":"Walnut","phase":"IN_PROGRESS","userState":"working","director":true,
        "workers":[{"kind":"task","id":"d2","title":"Ranking eval","project":"Walnut","phase":"TODO","userState":"needs","director":true,"workers":[
          {"kind":"task","id":"w1","title":"Golden set","project":"Walnut","phase":"TODO","userState":"waiting","director":false,"workers":[]}]}]},
       {"kind":"task","id":"p1","title":"Platform","project":"Walnut","phase":"TODO","userState":"waiting","director":false,
        "workers":[{"kind":"task","id":"d3","title":"Deploy guard","project":"Walnut","phase":"TODO","userState":"waiting","director":true,"workers":[]}]}
      ]},
     {"project":"Garden","lead":{"id":"lead-w","title":"Walnut VP","phase":"IN_PROGRESS"},"contactId":"lead-w","vp":"Walnut",
      "counts":{"open":2,"running":0,"needsYou":0,"waiting":2},
      "teams":[{"kind":"task","id":"g1","title":"Tomatoes","project":"Garden","phase":"TODO","userState":"read","director":true,"workers":[]},
               {"kind":"task","id":"d1","title":"Search rewrite","project":"Walnut","phase":"IN_PROGRESS","userState":"working","director":true,"workers":[]}]},
     {"project":"Operations","lead":{"id":"lead-o","title":"Operations VP","phase":"TODO","name":"Ops"},"contactId":"lead-o","vp":null,
      "counts":{"open":1,"running":0,"needsYou":0,"waiting":1},
      "teams":[{"kind":"task","id":"o1","title":"Backups","project":"Operations","phase":"TODO","userState":"waiting","director":false,"workers":[]}]}
    ]}}
    """

    private func tree(_ text: String = json) throws -> OrgTreeWire {
        try JSONDecoder().decode(OrgTreeResponse.self, from: Data(text.utf8)).tree
    }

    private func rows(_ t: OrgTreeWire) -> [ChatOrgModel.Row] { ChatOrgModel.rows(tree: t, tasks: []) }

    func testFoldListsAVPsDirectorsNestedAndGroupedByItsProjects() throws {
        let t = try tree()
        let folds = ChatDirectorsModel.folds(rows: rows(t), tree: t, tasks: [], showProjects: true)
        let walnut = try XCTUnwrap(folds["project:walnut"])
        // d1, d2 (nested), d3 (under a non-Director), g1; d1 once though Garden lists it too.
        XCTAssertEqual(walnut.count, 4)
        XCTAssertEqual(walnut.groups.map(\.project), ["Walnut", "Garden"])
        XCTAssertEqual(walnut.groups[0].directors.map(\.id), ["d1", "d2", "d3"])
        XCTAssertEqual(walnut.groups[0].directors.map(\.depth), [0, 1, 0])
        XCTAssertEqual(walnut.groups[1].directors.map(\.id), ["g1"])
        // A VP with no Director has no fold row.
        XCTAssertNil(folds["project:operations"])
        XCTAssertEqual(ChatDirectorsModel.countLabel(walnut.count), "4 directors")
        XCTAssertEqual(ChatDirectorsModel.countLabel(1), "1 director")
    }

    func testHiddenProjectNamesMakeOneGroupInTheSameOrder() throws {
        let t = try tree()
        let walnut = try XCTUnwrap(ChatDirectorsModel.folds(rows: rows(t), tree: t, tasks: [], showProjects: false)["project:walnut"])
        XCTAssertEqual(walnut.groups.count, 1)
        XCTAssertNil(walnut.groups[0].project)
        XCTAssertEqual(walnut.groups[0].directors.map(\.id), ["d1", "d2", "d3", "g1"])
    }

    func testSectionsListEveryDirectorFlatWithItsVP() throws {
        let t = try tree()
        let list = ChatDirectorsModel.sections(rows: rows(t), tree: t, tasks: [])
        XCTAssertEqual(list.map(\.id), ["d1", "d2", "d3", "g1"])
        XCTAssertEqual(ChatDirectorsModel.sectionLine(list[0]), "Walnut · Working")
        // To read is drawn as Needs you, on every surface.
        XCTAssertEqual(list[3].state, .needs)
        XCTAssertEqual(ChatDirectorsModel.vpInitial(list[0].vpName), "W")
        XCTAssertEqual(ChatDirectorsModel.vpInitial("  ops"), "O")
    }

    /// The task list's status (kept live by the feed) wins over the tree's, and its title too.
    func testTheTaskListsStatusAndTitleWin() throws {
        let t = try tree()
        let live = WalnutTask(
            id: "d3", title: "Deploy guard v2", status: "in_progress", phase: "IN_PROGRESS", priority: "none",
            project: "Walnut", dueDate: nil, createdAt: nil, updatedAt: nil, completedAt: nil,
            starred: nil, pinned: nil, tags: nil, summary: nil, userStatus: WalnutUserStatus(state: "working")
        )
        let d3 = try XCTUnwrap(ChatDirectorsModel.sections(rows: rows(t), tree: t, tasks: [live]).first { $0.id == "d3" })
        XCTAssertEqual(d3.state, .working)
        XCTAssertEqual(d3.title, "Deploy guard v2")
    }

    /// An older server sends no Director fields (and a newer one may send another type): the org
    /// still loads, with no Directors.
    func testAnOlderOrOddTreeStillDecodesWithNoDirectors() throws {
        let old = try tree("""
        {"tree":{"main":null,"counts":{"open":1,"running":0,"needsYou":0,"waiting":1},
        "projects":[{"project":"Walnut","vp":null,"counts":{"open":1,"running":0,"needsYou":0,"waiting":1},
          "teams":[{"id":"x","workers":[]},{"id":"y","director":"yes","title":7,"workers":[]}]}]}}
        """)
        XCTAssertEqual(old.projects[0].teams?.count, 2)
        XCTAssertNil(old.projects[0].teams?[1].director)
        XCTAssertNil(old.projects[0].teams?[1].title)
        XCTAssertTrue(ChatDirectorsModel.folds(rows: rows(old), tree: old, tasks: [], showProjects: true).isEmpty)
    }

    func testMarkingTakesOneTaskOffAtOnce() throws {
        let t = try tree()
        let after = ChatDirectorsModel.marking(t, id: "d2", director: false)
        let list = ChatDirectorsModel.sections(rows: rows(after), tree: after, tasks: [])
        XCTAssertEqual(list.map(\.id), ["d1", "d3", "g1"])
    }

    func testOpenRowOpensTheDirectorsOwnTask() throws {
        let t = try tree()
        let d = try XCTUnwrap(ChatDirectorsModel.sections(rows: rows(t), tree: t, tasks: []).first)
        let row = ChatDirectorsModel.openRow(d)
        XCTAssertEqual(row.kind, .director)
        XCTAssertEqual(row.contactId, "d1")
        XCTAssertEqual(row.name, "Search rewrite")
    }

    func testNewDirectorAsksForAProjectOnlyWhenTheVPLeadsSeveral() throws {
        let r = rows(try tree())
        let walnut = try XCTUnwrap(NewDirectorTarget(row: try XCTUnwrap(r.first { $0.id == "project:walnut" })))
        XCTAssertEqual(walnut.projects, ["Walnut", "Garden"])
        let ops = try XCTUnwrap(NewDirectorTarget(row: try XCTUnwrap(r.first { $0.id == "project:operations" })))
        XCTAssertEqual(ops.projects, ["Operations"])
        XCTAssertNil(NewDirectorTarget(row: try XCTUnwrap(r.first { $0.kind == .ceo })))
    }

    // MARK: - The rule and the settings

    func testTheRuleMatchesTheServers() {
        XCTAssertTrue(DirectorRule.isDirector(.yes, openWorkers: 0))
        XCTAssertFalse(DirectorRule.isDirector(.no, openWorkers: 3))
        XCTAssertTrue(DirectorRule.isDirector(nil, openWorkers: 1))
        XCTAssertFalse(DirectorRule.isDirector(.auto, openWorkers: 0))
    }

    private func task(_ id: String, project: String = "Walnut", parent: String? = nil, phase: String = "TODO",
                      orgRole: String? = nil, director: DirectorChoice? = nil) -> WalnutTask {
        WalnutTask(
            id: id, title: id, status: phase == "COMPLETE" ? "done" : "todo", phase: phase, priority: "none",
            project: project, dueDate: nil, createdAt: nil, updatedAt: nil, completedAt: nil,
            starred: nil, pinned: nil, tags: nil, summary: nil, parentTaskId: parent, orgRole: orgRole, director: director
        )
    }

    /// The task page's menu: its choice first, else an open subtask makes it one; the CEO, a VP
    /// and the Inbox take no choice.
    func testTheTaskPageMenuReadsTheRule() {
        let lead = task("a")
        let list = [lead, task("b", parent: "a"), task("c", parent: "a", phase: "COMPLETE")]
        XCTAssertEqual(DirectorRule.openWorkers(of: "a", in: list), 1)
        XCTAssertTrue(TaskDirectorMenu.isDirector(task: lead, written: nil, children: nil, list: list))
        XCTAssertFalse(TaskDirectorMenu.isDirector(task: lead, written: .no, children: nil, list: list))
        // The page's own read of its subtasks wins over the list's.
        let done = [TaskDetail.Relative(id: "b", title: "b", phase: "COMPLETE", status: "done")]
        XCTAssertFalse(TaskDirectorMenu.isDirector(task: lead, written: nil, children: done, list: list))
        XCTAssertTrue(TaskDirectorMenu.isDirector(task: task("z", director: .yes), written: nil, children: [], list: []))
        XCTAssertTrue(DirectorRule.canChoose(lead))
        XCTAssertFalse(DirectorRule.canChoose(task("v", orgRole: "lead")))
        XCTAssertFalse(DirectorRule.canChoose(task("i", project: "")))
    }

    /// The task row's choice decodes leniently: an unknown word is auto, and it survives a copy.
    @MainActor
    func testTheTaskRowCarriesTheChoice() throws {
        func decode(_ director: String) throws -> WalnutTask {
            let json = #"{"id":"t","title":"t","status":"todo","phase":"TODO","priority":"none","project":"Walnut","due_date":null,"#
                + #""created_at":null,"updated_at":null,"completed_at":null,"starred":null,"pinned":null,"tags":null,"summary":null"#
                + director + "}"
            return try JSONDecoder().decode(WalnutTask.self, from: Data(json.utf8))
        }
        XCTAssertEqual(try decode(#","director":"yes""#).director, .yes)
        XCTAssertEqual(try decode(#","director":"maybe""#).director, .auto)
        XCTAssertEqual(try decode(#","director":5"#).director, .auto)
        XCTAssertNil(try decode("").director)
        XCTAssertEqual(TasksStore.withPinned(try decode(#","director":"no""#), true).director, .no)
        XCTAssertEqual(TasksStore.applyEdit(.init(title: "x"), to: try decode(#","director":"no""#)).director, .no)
    }

    func testSettingsReadAbsentFieldsAsOffAndAnUnknownLayoutAsFold() throws {
        func decode(_ json: String) throws -> DirectorsSettings {
            DirectorsSettings(try JSONDecoder().decode(OrgSettingsView.self, from: Data(json.utf8)))
        }
        XCTAssertEqual(try decode(#"{"name":"Org"}"#), DirectorsSettings(enabled: false, layout: .fold, showProjects: true))
        XCTAssertEqual(try decode(#"{"directorsEnabled":true,"directorsLayout":"sections","directorsShowProjects":false}"#),
                       DirectorsSettings(enabled: true, layout: .sections, showProjects: false))
        XCTAssertEqual(try decode(#"{"directorsEnabled":true,"directorsLayout":"grid","directorsShowProjects":"no"}"#),
                       DirectorsSettings(enabled: true, layout: .fold, showProjects: true))
    }

    @MainActor
    func testTheSettingsAreKeptOnThePhone() throws {
        let suite = "directors-settings-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = DirectorsSettingsStore(defaults: defaults)
        XCTAssertFalse(store.value.enabled)
        store.adopt(DirectorsSettings(enabled: true, layout: .sections, showProjects: false))
        XCTAssertEqual(DirectorsSettingsStore(defaults: defaults).value, DirectorsSettings(enabled: true, layout: .sections, showProjects: false))
    }

    func testTheFoldIsKeptPerVP() {
        XCTAssertNotEqual(ChatDirectorFold.storageKey("project:walnut"), ChatDirectorFold.storageKey("project:ops"))
        XCTAssertTrue(ChatDirectorFold.storageKey("project:walnut").hasPrefix(ViewMemory.prefix))
    }
}
