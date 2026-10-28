import XCTest
@testable import Walnut

/// The Chat drawer's org view (ChatOrgModel), the twin of the web Org page's channel rows
/// (web/src/components/org/org-channels-model.ts): the CEO, then one row per VP with the
/// projects under it folded in, by the same user status.
final class ChatOrgModelTests: XCTestCase {
    /// `GET /api/v1/org` as the live server answers it (trimmed): `vp: null` on a VP's own
    /// project, teams the phone does not read, a VP-only project with no open work.
    private static let liveJSON = """
    {"tree":{"main":{"id":"main-1","title":"Main","phase":"IN_PROGRESS","hasSession":false},
    "counts":{"open":40,"running":9,"needsYou":8,"waiting":23},
    "projects":[
     {"project":"Walnut","lead":{"id":"lead-w","title":"Walnut lead","phase":"IN_PROGRESS","hasSession":true},
      "needsLead":true,"contactId":"lead-w","vp":null,"counts":{"open":28,"running":9,"needsYou":3,"waiting":16},
      "teams":[{"kind":"task","id":"t1","title":"x","project":"Walnut","phase":"TODO","userState":"waiting","hasSession":false,"workers":[],"counts":{"open":1,"running":0,"needsYou":0,"waiting":1}}]},
     {"project":"Dock Team","lead":{"id":"lead-m","title":"Marina lead","phase":"NEED_ACTION","hasSession":true},
      "needsLead":true,"contactId":"lead-m","vp":"Marina","counts":{"open":9,"running":0,"needsYou":3,"waiting":6},"teams":[]},
     {"project":"Personal","lead":{"id":"lead-p","title":"Personal lead","phase":"NEED_ACTION","hasSession":true},
      "needsLead":true,"contactId":"lead-p","vp":null,"counts":{"open":3,"running":0,"needsYou":1,"waiting":2},"teams":[]},
     {"project":"Tax","lead":{"id":"lead-p","title":"Personal lead","phase":"NEED_ACTION","hasSession":true},
      "needsLead":true,"contactId":"lead-p","vp":"Personal","counts":{"open":2,"running":0,"needsYou":0,"waiting":2},"teams":[]},
     {"project":"Marina","lead":{"id":"lead-m","title":"Marina lead","phase":"NEED_ACTION","hasSession":true},
      "needsLead":false,"contactId":"lead-m","vp":null,"counts":{"open":1,"running":0,"needsYou":0,"waiting":1},"teams":[]},
     {"project":"Operations","lead":{"id":"lead-o","title":"Operations lead","phase":"IN_PROGRESS","hasSession":true,"name":"Ops"},
      "needsLead":false,"contactId":"lead-o","vp":null,"counts":{"open":0,"running":0,"needsYou":0,"waiting":0},"teams":[]},
     {"project":"","needsLead":false,"counts":{"open":3,"running":0,"needsYou":1,"waiting":2},"teams":[]}
    ]}}
    """

    private func tree() throws -> OrgTreeWire {
        try JSONDecoder().decode(OrgTreeResponse.self, from: Data(Self.liveJSON.utf8)).tree
    }

    private func task(_ id: String, phase: String, user: String?, updatedAt: String? = nil) -> WalnutTask {
        WalnutTask(
            id: id, title: id, status: "in_progress", phase: phase, priority: "none", project: "",
            dueDate: nil, createdAt: nil, updatedAt: updatedAt, completedAt: nil,
            starred: nil, pinned: nil, tags: nil, summary: nil,
            userStatus: user.map { WalnutUserStatus(state: $0) }, orgRole: "lead"
        )
    }

    func testDecodesTheLiveShape() throws {
        let t = try tree()
        XCTAssertEqual(t.main?.id, "main-1")
        XCTAssertEqual(t.projects.count, 7)
        XCTAssertNil(t.projects[0].vp)
        XCTAssertEqual(t.projects[1].vp, "Marina")
        XCTAssertEqual(t.projects[5].lead?.name, "Ops")
        XCTAssertNil(t.projects[6].lead)
    }

    /// The CEO, then one row per VP: a project under another VP is in that VP's row, and the
    /// Inbox (no VP) has no row.
    func testOneRowPerVPWithLedProjectsFolded() throws {
        let rows = ChatOrgModel.rows(tree: try tree(), tasks: [])
        XCTAssertEqual(rows.map(\.name), ["CEO", "Marina", "Personal", "Walnut", "Ops"])
        let marina = try XCTUnwrap(rows.first { $0.name == "Marina" })
        XCTAssertEqual(marina.ledProjects, ["Dock Team"])
        XCTAssertEqual(marina.open, 10)
        XCTAssertEqual(marina.contactId, "lead-m")
        let personal = try XCTUnwrap(rows.first { $0.name == "Personal" })
        XCTAssertEqual(personal.ledProjects, ["Tax"])
        XCTAssertEqual(personal.open, 5)
        XCTAssertFalse(rows.contains { $0.project.isEmpty && $0.kind == .vp })
    }

    /// By the user's status: Needs you, then Working, then Waiting; the VP itself counts once
    /// on its own row (the task list's `user_status` wins over the tree's phase).
    func testStatesAndBadgesFollowTheUserStatus() throws {
        let tasks = [
            task("lead-m", phase: "NEED_ACTION", user: "needs"),
            task("lead-p", phase: "NEED_ACTION", user: "waiting"),
            task("main-1", phase: "IN_PROGRESS", user: "waiting"),
        ]
        let rows = ChatOrgModel.rows(tree: try tree(), tasks: tasks)
        let by = Dictionary(uniqueKeysWithValues: rows.map { ($0.name, $0) })
        XCTAssertEqual(by["Marina"]?.state, .needs)
        XCTAssertEqual(by["Marina"]?.needs, 4) // 3 in Dock Team + the VP itself
        XCTAssertEqual(by["Personal"]?.state, .needs)
        XCTAssertEqual(by["Personal"]?.needs, 1) // its stored status says waiting
        XCTAssertEqual(by["Walnut"]?.state, .needs)
        XCTAssertEqual(by["Walnut"]?.working, 9)
        XCTAssertEqual(by["Ops"]?.state, .waiting)
        XCTAssertEqual(by["Ops"]?.line, "Nothing open")
        // The CEO waits itself, and works while any team works.
        XCTAssertEqual(by["CEO"]?.state, .working)
        XCTAssertEqual(by["CEO"]?.needs, 0)
        // The VP rows' needs (4 + 1 + 3): the line adds up to the rows under it, the Inbox has none.
        XCTAssertEqual(by["CEO"]?.line, "4 VPs · 9 working · 8 need you")
    }

    func testWithoutTheTaskListTheTreePhaseDecides() throws {
        let rows = ChatOrgModel.rows(tree: try tree(), tasks: [])
        XCTAssertEqual(rows.first { $0.name == "Marina" }?.needs, 4)
        XCTAssertEqual(rows.first?.kind, .ceo)
        XCTAssertEqual(rows.first?.state, .working)
    }

    /// Inside one state: the newest move first (the VP, or any task in the row, a led project's
    /// included), then by project name, as the Org page sorts.
    func testInsideOneStateTheNewestMoveComesFirst() throws {
        var t = try tree()
        for i in t.projects.indices { t.projects[i].counts = OrgCountsWire(open: 1, running: 0, needsYou: 0, waiting: 1) }
        var tasks = ["lead-w", "lead-m", "lead-p", "lead-o"].map { task($0, phase: "WAITING", user: "waiting") }
        // Without times: by project name.
        XCTAssertEqual(ChatOrgModel.rows(tree: t, tasks: tasks).map(\.name), ["CEO", "Marina", "Ops", "Personal", "Walnut"])
        // Ops' VP moved last, then a worker deep in Dock Team (led by Marina), then Walnut's task.
        tasks[3] = task("lead-o", phase: "WAITING", user: "waiting", updatedAt: "2026-10-28T10:00:00Z")
        tasks.append(task("t1", phase: "TODO", user: "waiting", updatedAt: "2026-10-28T09:00:00Z"))
        tasks.append(task("w-deep", phase: "TODO", user: "waiting", updatedAt: "2026-10-28T09:30:00Z"))
        let dock = try XCTUnwrap(t.projects.firstIndex { $0.project == "Dock Team" })
        t.projects[dock].teams = [OrgTeamNodeWire(id: "e1", workers: [OrgTeamNodeWire(id: "w-deep")])]
        let rows = ChatOrgModel.rows(tree: t, tasks: tasks)
        XCTAssertEqual(rows.map(\.name), ["CEO", "Ops", "Marina", "Walnut", "Personal"])
        XCTAssertTrue(rows.dropFirst().allSatisfy { $0.state == .waiting })
    }

    /// A project whose VP's own project is not in the tree keeps a row of its own.
    func testAProjectWhoseVPIsMissingKeepsItsRow() throws {
        var t = try tree()
        t.projects.removeAll { $0.project == "Marina" }
        let rows = ChatOrgModel.rows(tree: t, tasks: [])
        XCTAssertTrue(rows.contains { $0.name == "Dock Team" })
    }

    /// No Main yet and a project still without its VP: the rows exist, and the tap asks the
    /// server for the node (no contact id here).
    func testNodesNotMadeYetHaveNoContact() throws {
        let json = """
        {"tree":{"projects":[{"project":"Garden","needsLead":true,"counts":{"open":2,"running":1,"needsYou":0,"waiting":1}}],
        "counts":{"open":2,"running":1,"needsYou":0,"waiting":1}}}
        """
        let t = try JSONDecoder().decode(OrgTreeResponse.self, from: Data(json.utf8)).tree
        let rows = ChatOrgModel.rows(tree: t, tasks: [])
        XCTAssertEqual(rows.map(\.name), ["CEO", "Garden"])
        XCTAssertNil(rows[0].contactId)
        XCTAssertNil(rows[1].contactId)
        XCTAssertEqual(rows[1].state, .working)
        XCTAssertEqual(rows[1].line, "Working · 2 open")
        XCTAssertEqual(rows[0].line, "1 VP · 1 working")
    }

    func testInitialsAndColorsMatchTheWeb() {
        XCTAssertEqual(ChatOrgModel.initials("Walnut"), "WA")
        XCTAssertEqual(ChatOrgModel.initials("Acme Marina Team"), "AM")
        XCTAssertEqual(ChatOrgModel.initials("ai-context"), "AC")
        XCTAssertEqual(ChatOrgModel.initials("\u{5BB6}\u{5EAD}"), "\u{5BB6}\u{5EAD}")
        // web/src/components/org/org-channels-model.ts avatarColor, same names.
        XCTAssertEqual(ChatOrgModel.avatarColor("Walnut"), 0x2AA7B8)
        XCTAssertEqual(ChatOrgModel.avatarColor("Marina"), 0x5B8DEF)
        XCTAssertEqual(ChatOrgModel.avatarColor("Personal"), 0x3BAA75)
        XCTAssertEqual(ChatOrgModel.avatarColor("Operations"), 0xE05297)
        XCTAssertEqual(ChatOrgModel.avatarColor("\u{5BB6}\u{5EAD}"), 0x2AA7B8)
    }

    /// The session a tap opens is the web's (`resolveTaskSessionId`): the task's own slot first,
    /// else the newest of `session_ids` (Main keeps none in its slot).
    func testTheSessionATapOpensIsTheWebs() throws {
        func detail(_ json: String) throws -> TaskDetail {
            try JSONDecoder().decode(TaskDetailEnvelope.self, from: Data(json.utf8)).task
        }
        let lead = try detail(#"{"task":{"id":"l","title":"Lead","session_id":"s-now","session_ids":["s-now","s-later"]}}"#)
        XCTAssertEqual(lead.currentSessionId, "s-now")
        let main = try detail(#"{"task":{"id":"m","title":"Main","session_ids":["s-old","s-new"]}}"#)
        XCTAssertEqual(main.currentSessionId, "s-new")
        let exec = try detail(#"{"task":{"id":"e","title":"E","session_id":" ","exec_session_id":"x-1","session_ids":[]}}"#)
        XCTAssertEqual(exec.currentSessionId, "x-1")
        let none = try detail(#"{"task":{"id":"n","title":"N","session_ids":[]}}"#)
        XCTAssertNil(none.currentSessionId)
    }

    /// A load the drawer's opening cancelled is not an error to show.
    func testACancelledLoadIsNotAnError() {
        XCTAssertTrue(ChatDrawer.isCancellation(CancellationError()))
        XCTAssertTrue(ChatDrawer.isCancellation(APIError.cancelled))
        XCTAssertFalse(ChatDrawer.isCancellation(APIError.badResponse))
    }

    func testACompanionRefusalSaysTheMacIsNeeded() {
        let refused = APIError.server(status: 501, code: "not_supported_cloud", message: "x", serverHash: nil, serverContent: nil)
        XCTAssertEqual(ChatView.orgFailure("Design", refused), "Design can be started only while your Mac is online.")
    }

    func testTheOrgViewIsTheDefaultPick() {
        XCTAssertEqual(ChatDrawerView.storageKey, "chat.drawer.view")
        XCTAssertEqual(ChatDrawerView.allCases.first, .org)
        XCTAssertEqual(ChatDrawerOrgList.accessibilityText(ChatOrgModel.Row(
            id: "project:marina", kind: .vp, name: "Marina", contactId: "x", project: "Marina",
            state: .needs, needs: 2, working: 0, open: 5, ledProjects: ["Tax"], line: "Needs you · 5 open"
        )), "Marina, VP, also leads Tax, Needs you · 5 open, 2 need you")
    }
}
